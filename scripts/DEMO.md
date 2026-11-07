# Demo connection options

Run `npm.cmd run demo` from the repository root in a terminal. Choose a connection:

- **HTTPS LAN** (Enter, `1`, or `--local`): detects the laptop's Wi-Fi address. Recognition uses HTTPS 5055, Auth HTTPS 9449, Firestore HTTPS 8443, and Metro HTTPS/WSS 8081. The phone must trust the LAN CA.
- **Tailscale** (`2` or `--tailscale`): detects the laptop's Tailscale address and MagicDNS hostname. Private Serve HTTPS endpoints protect recognition (443), Auth (9449), and Firestore (8443); the tailnet protects Expo traffic.

Skip the prompt with `npm.cmd run demo -- --local` (`npm run demo:lan`) or
`npm.cmd run demo -- --tailscale`. `npm run demo:tunnel` remains an alias for
Tailscale. The old public `--expo-tunnel` option is rejected.
Noninteractive runs and `npm.cmd run demo:check` default to HTTPS LAN. The check
validates local configuration but does not start services or verify phone trust.

The mobile check-in screen uses the combined backend request. After updating,
restart the launcher so the current Firestore rules load: students can read
their attendance but cannot create, update or delete it directly. Instructor
camera/manual/default attendance remains available for owned courses. Both
rule files enforce the same policy; production requires an explicit rules
deployment. See [check-in enforcement](../README.md#verified-attendance-check-in).

Run the isolated combined HTTPS check with `npm run test:step6`; it uses synthetic
data without touching this demo's saved records. Follow the [check-in validation
checklist](../README.md#check-in-validation) for the physical checks. Automated
success does not verify the phone's GPS, native trust or camera/location indicators.

## HTTPS LAN certificate setup

1. Keep the existing Python environment, Docker and mkcert installed. Complete
   the one-time `mkcert -install` setup on the laptop. The launcher reuses a valid
   certificate, or generates a certificate for the detected Wi-Fi IP plus
   localhost using the existing mkcert CA. It does not reinstall a CA.
2. Find the public CA certificate using `mkcert -CAROOT`. Transfer **rootCA.pem**
   to the phone using a trusted method. Never transfer rootCA-key.pem, the server
   private key or the embedding key. Use `.env.demo` overrides in
   `.env.demo.example` if certificate paths differ. FACEROLL_TLS_CA may point to
   the public CA certificate; otherwise the launcher discovers it via mkcert.
3. On iOS, install the CA profile, then enable full trust in Settings > General >
   About > Certificate Trust Settings. Restart Expo Go after changing trust.
   On Android, certificate trust also depends on the native client's network
   security configuration: installing a user CA is not sufficient for every
   Expo Go build. If the client rejects the CA, use Tailscale or a development
   build configured to trust your development CA. Do not disable TLS validation.
4. Connect both devices to the same Wi-Fi. Allow inbound TCP 5055, 9449, 8443 and
   8081 from the phone through Windows Firewall. The launcher does not change
   firewall rules. Campus Wi-Fi may isolate devices; use a private hotspot or
   Tailscale if they cannot reach each other.
5. Run `npm run demo -- --local`. On the phone, check
   `https://<laptop-Wi-Fi-IP>:5055/health` with no certificate warning. Then scan
   the launcher's **HTTPS LAN QR** (`exps://...:8081`) in Expo Go. Expo's built-in
   native QR is suppressed because it still assumes `exp://`/HTTP. Ignore a
   legacy exp:// text address printed by Expo. Confirm login and check-in on the
   actual phone; browser trust alone does not establish native app trust.

Changing Wi-Fi addresses regenerates only the server certificate, using the same
CA. You do not need to reinstall that CA on the phone. A changed CA does require
updating phone trust. `npm run test:lan:https` verifies a real Metro HTTPS
manifest, Android bundle and WSS connection using disposable certificates; it
does not install certificates or replace a physical-phone rehearsal.

## Tailscale prerequisites

1. Install Tailscale on the laptop and phone and connect both to the same tailnet.
2. Keep the existing demo Python environment, Docker, and local TLS certificate/key installed. Tailscale mode still uses those files for the loopback recognition server, but the certificate does not need to include the Tailscale IP.
3. Choose Tailscale when launching. If Serve prints an HTTPS setup link, follow it to enable HTTPS and MagicDNS. The phone uses the valid Tailscale HTTPS certificate; only the loopback proxy connection accepts the existing self-signed certificate.
4. Allow TCP 443 (recognition), 9449 (Auth HTTPS), 8443 (Firestore HTTPS), and the Expo port shown in the terminal (normally 8081) from the phone's Tailscale IP through Windows Firewall and tailnet access rules. Raw Auth/Firestore ports 9099/8080 bind only to laptop loopback. The launcher does not change firewall rules.
5. Scan the Expo QR code with your compatible Expo client. Keep Tailscale connected. Use the localhost dashboard URL printed by the launcher on the laptop.
6. Rehearse login, recognition, attendance, and export on campus before the demo.

Serve runs as a foreground child of the launcher and is stopped with the demo. Existing Serve configurations are rejected instead of overwritten. No public Funnel is started. Press Ctrl+C once to stop the demo and preserve emulator data.

Both devices still need internet connectivity. Tailscale does not guarantee access on a network that blocks it; retain a hotspot backup.

Reference: https://tailscale.com/docs/reference/tailscale-cli/serve

Expo references: [local HTTPS](https://docs.expo.dev/guides/local-https-development/),
[Expo Go secure links](https://docs.expo.dev/linking/into-your-app/).
