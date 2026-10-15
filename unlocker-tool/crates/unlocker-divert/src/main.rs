//! Windows DNS interception sidecar for firmwares that hardcode a public
//! resolver.
//!
//! Background: the normal Windows path spoofs DNS via the `hosts` file, which
//! only works when the device uses the resolver ICS hands out over DHCP. X4 Pro
//! XTOS V7.6.x (CN) ignores that and queries AliDNS `223.5.5.5` directly, so ICS
//! NAT forwards it upstream and our spoof never participates (crosspoint-reader
//! #3775, #51). macOS/Linux don't have this problem because their pf/iptables
//! rule redirects *all* outbound UDP/53 regardless of destination; Windows ICS
//! exposes no equivalent, so we capture the query with WinDivert and answer it.
//!
//! Capture + injection follow the approach proven on a real device in issue #51:
//! ICS makes the reader's query appear on the **forward** layer, outbound, in
//! two copies — one pre-NAT (`src = 192.168.137.x`) and one post-NAT
//! (`src = the PC's upstream IP`). We watch BOTH the forward and network layers,
//! and we always inject the spoofed reply on the **network** handle with a
//! hand-built address: toward a hotspot client it's an *outbound* packet; toward
//! the PC's own post-NAT address it's *inbound* on the same interface and ICS
//! translates it back to the reader. (Re-sending on the forward handle with the
//! captured address never routes the reply back — that was the earlier bug.)
//!
//! The byte-level WinDivert address control this needs isn't exposed by the safe
//! `windivert` crate, so we call the raw C API directly. `WinDivert.dll` must sit
//! next to this exe at runtime; the import lib is linked in `build.rs`.
//!
//! Why a separate process: a missing or AV-quarantined `WinDivert.dll` stops any
//! binary that imports it from starting. The privileged helper must always
//! start, so the capture loop lives here — if WinDivert is unavailable the helper
//! carries on with hosts-file spoofing. The helper spawns us when the user
//! enables the Settings toggle and stops us by killing the process.
//!
//! Usage: unlocker-divert.exe --bridge-ip <ipv4> --hosts <name>[,<name>...]
//!
//! Diagnostics go to stderr, which the helper reads into its own log. The
//! packet parse/rewrite/checksum core lives in `unlocker_core::dns_intercept`
//! and is unit-tested cross-platform.

#[cfg(not(windows))]
fn main() {
    eprintln!("unlocker-divert is Windows-only");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use std::net::Ipv4Addr;

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_target(false)
        .without_time()
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut bridge_ip: Option<Ipv4Addr> = None;
    let mut hosts: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--bridge-ip" => {
                let Some(v) = args.get(i + 1) else {
                    fail("--bridge-ip needs a value");
                };
                match v.parse() {
                    Ok(ip) => bridge_ip = Some(ip),
                    Err(e) => fail(&format!("--bridge-ip '{v}' is not an IPv4 address: {e}")),
                }
                i += 2;
            }
            "--hosts" => {
                let Some(v) = args.get(i + 1) else {
                    fail("--hosts needs a value");
                };
                hosts = v
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                i += 2;
            }
            other => fail(&format!("unexpected argument '{other}'")),
        }
    }

    let Some(bridge_ip) = bridge_ip else {
        fail("missing --bridge-ip");
    };
    if hosts.is_empty() {
        fail("missing --hosts");
    }

    run(hosts, bridge_ip);
}

#[cfg(windows)]
fn fail(msg: &str) -> ! {
    eprintln!("unlocker-divert: {msg}");
    eprintln!("usage: unlocker-divert.exe --bridge-ip <ipv4> --hosts <name>[,<name>...]");
    std::process::exit(2);
}

// ── Raw WinDivert FFI (WinDivert 2.x) ────────────────────────────────────────
#[cfg(windows)]
mod windivert {
    use std::os::raw::c_char;

    pub type Handle = isize;
    pub const INVALID_HANDLE: Handle = -1;
    pub const LAYER_NETWORK: i32 = 0;
    pub const LAYER_FORWARD: i32 = 1;
    /// `WINDIVERT_ADDRESS` is 80 bytes on WinDivert 2.x.
    pub const ADDR_SIZE: usize = 80;
    /// Byte offset of the `Layer` field.
    pub const ADDR_LAYER: usize = 8;
    /// Byte offset of the flags bitfield; `Outbound` is bit 1.
    pub const ADDR_FLAGS: usize = 10;
    pub const OUTBOUND: u8 = 0x02;
    /// `IfIdx` (u32) at 16, `SubIfIdx` (u32) at 20 — 8 contiguous bytes.
    pub const ADDR_IFIDX: usize = 16;
    pub const ADDR_IFIDX_LEN: usize = 8;

    // No calling-convention attribute: WinDivert's exports are __cdecl, which is
    // the single x86-64 convention, matching `extern "C"`.
    extern "C" {
        pub fn WinDivertOpen(
            filter: *const c_char,
            layer: i32,
            priority: i16,
            flags: u64,
        ) -> Handle;
        pub fn WinDivertRecv(
            handle: Handle,
            packet: *mut u8,
            packet_len: u32,
            recv_len: *mut u32,
            addr: *mut u8,
        ) -> i32;
        pub fn WinDivertSend(
            handle: Handle,
            packet: *const u8,
            packet_len: u32,
            send_len: *mut u32,
            addr: *const u8,
        ) -> i32;
    }
}

#[cfg(windows)]
fn run(spoofed_hosts: Vec<String>, bridge_ip: std::net::Ipv4Addr) {
    use std::sync::Arc;
    use windivert::*;

    let o = bridge_ip.octets();
    let net = format!("{}.{}.{}", o[0], o[1], o[2]); // hotspot /24 prefix
    // Local layer: queries from hotspot clients, plus anything leaving after ICS
    // NAT. Forward layer: everything ICS routes through this PC.
    let network_filter = format!(
        "udp.DstPort == 53 and ((inbound and ip.SrcAddr >= {net}.2 and ip.SrcAddr <= {net}.254 \
         and ip.DstAddr != {bridge_ip}) or (outbound and ip))"
    );
    let forward_filter = "ip and udp.DstPort == 53".to_string();

    // Opening a handle is what installs + starts the WinDivert kernel driver.
    // Failing here is normal when the driver can't load; exit non-zero and let
    // the helper log it and carry on with hosts-file spoofing only.
    let network = match open(&network_filter, LAYER_NETWORK) {
        Ok(h) => h,
        Err(e) => return driver_unavailable(e),
    };
    let forward = match open(&forward_filter, LAYER_FORWARD) {
        Ok(h) => h,
        Err(e) => return driver_unavailable(e),
    };

    tracing::info!(%bridge_ip, hosts = spoofed_hosts.len(),
        "WinDivert DNS interceptor armed (network + forward)");

    // The reply is always injected on the network handle, so both capture loops
    // share it. A raw handle is just a number (Copy + Send).
    let hosts = Arc::new(spoofed_hosts);
    let net_prefix = [o[0], o[1], o[2]];

    let hosts1 = hosts.clone();
    let t1 = std::thread::spawn(move || {
        capture_loop(network, network, &hosts1, bridge_ip, net_prefix, "local")
    });
    let hosts2 = hosts.clone();
    let t2 = std::thread::spawn(move || {
        capture_loop(forward, network, &hosts2, bridge_ip, net_prefix, "forward")
    });
    let _ = t1.join();
    let _ = t2.join();
}

#[cfg(windows)]
fn driver_unavailable(err: std::io::Error) {
    tracing::error!(error = %err,
        "WinDivert unavailable (driver missing or blocked); devices that hardcode a \
         public resolver (e.g. X4 Pro XTOS V7.6.x CN) will not be captured");
    std::process::exit(3);
}

#[cfg(windows)]
fn open(filter: &str, layer: i32) -> std::io::Result<windivert::Handle> {
    use std::ffi::CString;
    let c = CString::new(filter).expect("filter has no interior NUL");
    // Priority 1000 keeps us ahead of anything else poking UDP/53 (matches the
    // proven responder from issue #51).
    let h = unsafe { windivert::WinDivertOpen(c.as_ptr(), layer, 1000, 0) };
    if h == windivert::INVALID_HANDLE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(h)
}

/// Recv → spoof-or-pass loop for one WinDivert handle. Spoofed replies are
/// injected on `inject` (the network handle); non-matching packets are
/// re-injected unchanged on the handle they arrived on.
#[cfg(windows)]
fn capture_loop(
    recv: windivert::Handle,
    inject: windivert::Handle,
    hosts: &[String],
    bridge_ip: std::net::Ipv4Addr,
    net_prefix: [u8; 3],
    stage: &str,
) {
    use unlocker_core::dns_intercept::spoof_forwarded_dns;
    use windivert::*;

    let mut pkt = vec![0u8; 0xFFFF];
    let mut addr = [0u8; ADDR_SIZE];

    loop {
        let mut n: u32 = 0;
        let ok = unsafe {
            WinDivertRecv(recv, pkt.as_mut_ptr(), pkt.len() as u32, &mut n, addr.as_mut_ptr())
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            match err.raw_os_error() {
                // ERROR_INVALID_HANDLE / ERROR_OPERATION_ABORTED / shutdown.
                Some(6) | Some(995) | Some(232) => return,
                _ => {
                    tracing::debug!(%stage, error = %err, "WinDivert recv error");
                    continue;
                }
            }
        }
        let n = n as usize;

        match spoof_forwarded_dns(&pkt[..n], hosts, bridge_ip) {
            Some(reply) => {
                // Build the reply's WinDivert address: same interface as the
                // query, delivered on the network layer. Toward a hotspot client
                // the reply is outbound; toward the PC's own post-NAT address it
                // is inbound and ICS translates it back. The reply's dst IP is at
                // bytes 16..20.
                let mut raddr = [0u8; ADDR_SIZE];
                raddr[ADDR_IFIDX..ADDR_IFIDX + ADDR_IFIDX_LEN]
                    .copy_from_slice(&addr[ADDR_IFIDX..ADDR_IFIDX + ADDR_IFIDX_LEN]);
                raddr[ADDR_LAYER] = LAYER_NETWORK as u8;
                let to_hotspot = reply[16..19] == net_prefix;
                if to_hotspot {
                    raddr[ADDR_FLAGS] |= OUTBOUND;
                }
                // Reply bytes already carry correct IPv4/UDP checksums (built in
                // dns_intercept), so no WinDivert recalc is needed.
                let mut sent: u32 = 0;
                let ok = unsafe {
                    WinDivertSend(
                        inject,
                        reply.as_ptr(),
                        reply.len() as u32,
                        &mut sent,
                        raddr.as_ptr(),
                    )
                };
                if ok == 0 {
                    tracing::debug!(%stage, error = %std::io::Error::last_os_error(),
                        "WinDivert send (spoofed reply) failed");
                } else {
                    tracing::info!(%stage, "spoofed DNS answer injected");
                }
            }
            None => {
                // Not a spoofed name (or not a DNS query): re-inject unchanged so
                // normal resolution (incl. NTP) keeps working through ICS.
                let mut sent: u32 = 0;
                let ok = unsafe {
                    WinDivertSend(recv, pkt.as_ptr(), n as u32, &mut sent, addr.as_ptr())
                };
                if ok == 0 {
                    tracing::debug!(%stage, error = %std::io::Error::last_os_error(),
                        "WinDivert send (pass-through) failed");
                }
            }
        }
    }
}
