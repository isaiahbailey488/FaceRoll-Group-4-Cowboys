# Demo connection options

Run `npm.cmd run demo` from the repository root in a terminal. Choose:

- **1 — Local Wi-Fi** (Enter): uses the existing local demo certificate and Wi-Fi address.
- **2 — Tailscale**: detects the connected laptop's Tailscale IPv4 address and MagicDNS hostname, starts private Tailscale Serve HTTPS for recognition, and advertises the Tailscale address to Expo and the mobile Firebase client.

Skip the prompt with `npm.cmd run demo -- --local` or `npm.cmd run demo -- --tailscale`.
Noninteractive runs default to Local. `npm.cmd run demo:check` defaults to Local without prompting; append `-- --tailscale` to validate Tailscale configuration. The check does not start services or verify phone connectivity.

## Tailscale prerequisites

1. Install Tailscale on the laptop and phone and connect both to the same tailnet.
2. Keep the existing demo Python environment, Docker, and local TLS certificate/key installed. Tailscale mode still uses those files for the loopback recognition server, but the certificate does not need to include the Tailscale IP.
3. Choose Tailscale when launching. If Serve prints an HTTPS setup link, follow it to enable HTTPS and MagicDNS. The phone uses the valid Tailscale HTTPS certificate; only the loopback proxy connection accepts the existing self-signed certificate.
4. Allow TCP 9099 (Auth), 8080 (Firestore), and the Expo port shown in the terminal (normally 8081) from the phone's Tailscale IP through Windows Firewall. Tailnet access rules must allow these ports and HTTPS 443. The launcher does not change firewall rules.
5. Scan the Expo QR code with your compatible Expo client. Keep Tailscale connected. Use the localhost dashboard URL printed by the launcher on the laptop.
6. Rehearse login, recognition, attendance, and export on campus before the demo.

Serve runs as a foreground child of the launcher and is stopped with the demo. Existing Serve configurations are rejected instead of overwritten. No public Funnel is started. Press Ctrl+C once to stop the demo and preserve emulator data.

Both devices still need internet connectivity. Tailscale does not guarantee access on a network that blocks it; retain a hotspot backup.

Reference: https://tailscale.com/docs/reference/tailscale-cli/serve
