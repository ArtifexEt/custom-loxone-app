# Custom Loxone App

An installable web app for Loxone intercoms. Choose which intercoms appear in the dashboard and configure their history and text-to-speech shortcuts in Settings.

[Open the app on GitHub Pages](https://artifexet.github.io/custom-loxone-app/)

## Connect a Miniserver

### GitHub Pages

1. Enable **Remote Connect** in Loxone Config for your registered Miniserver. Find its serial number (MAC address) in the Miniserver properties or on the device label. [Enable Remote Connect](https://www.loxone.com/enen/kb/remote-connect/) · [Find the serial number](https://www.loxone.com/enen/kb/initial-setup-miniserver/)
2. Open the app and enter the 12 hexadecimal digits of the serial number, with or without colons or hyphens. You can also enter `https://connect.loxonecloud.com/<serial>`.
3. Sign in with a Miniserver user that can access the intercom, then select the intercom to add to the dashboard. Connection and view settings are stored in the current browser profile.

GitHub Pages serves the static app. Your browser looks up the Loxone relay and connects over secure WebSocket. If the lookup fails, open `https://connect.loxonecloud.com/<serial>` in a separate browser tab. Copy the resulting HTTPS address after Loxone redirects you and use it as the Miniserver address in the app. Relay addresses can change. [Miniserver API v17](https://www.loxone.com/enen/kb/api/) · [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

### Local network

When using an HTTPS app with a private IPv4 address, include the Miniserver serial number so the app can try the Loxone TLS hostname. That path requires a Miniserver with a Loxone CloudDNS certificate and a browser that can access the local network. You can also use a direct HTTPS Miniserver address with a certificate your browser trusts. A local HTTP build can connect to a local HTTP Miniserver. [Loxone HTTPS/WSS documentation](https://www.loxone.com/enen/wp-content/uploads/sites/3/2026/04/1700_Communicating-with-the-Miniserver.pdf) · [Chrome local network access guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)

Two-way audio requires browser microphone permission and a secure page context, such as HTTPS or localhost. The app shell can load offline. Live intercom features require a connection.

## Samsung Family Hub

Open **Internet** on the refrigerator and go to your app's HTTPS address with `?panel=1` to open the touch dashboard. Save the address as a bookmark, or use **Add to Home Screen** if Internet offers it. Menu options vary by model, region and firmware. [Samsung Family Hub browser guide](https://www.samsung.com/in/support/home-appliances/how-to-access-youtube-on-samsung-family-hub-refrigerator/) · [Samsung Family Hub home screen](https://www.samsung.com/au/support/home-appliances/family-hub-homescreen-operations/)

You can also enable **Panel mode** in app settings. It puts large call controls below the camera and plays up to three saved phrases with a single tap. Full screen and **Keep the screen on** are available when the browser supports them. Keeping the screen awake applies while the dashboard is visible and depends on the device's power policy. [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/)

Use **Install app** when your browser offers PWA installation. Family Hub website shortcuts open the Internet app. Samsung controls the selection of apps in the refrigerator's Apps menu. [Samsung Family Hub Apps](https://www.samsung.com/us/support/answer/ANS10006847/)

After the app cache is ready, browsers that support service workers can reopen it without a network round trip. The saved view appears while the connection starts. Returning to the app after sleep checks the Miniserver connection. Live video and intercom controls still need a connection. Two-way audio uses WebRTC and requires the refrigerator's browser to expose the microphone and grant permission. Keep the page active for doorbell updates.

## Intercom compatibility

- **Intercom Gen. 2** appears as `IntercomV2` in the Miniserver structure. Its camera and microphone use WebRTC. The app establishes video first, then negotiates two-way audio on that session when you start talking. The signaling sequence comes from the Loxone Home Assistant integration, where it was verified on a locally paired physical Intercom Gen. 2. Media availability depends on network reachability and firmware. [Loxone Structure File](https://www.loxone.com/enen/wp-content/uploads/sites/3/2026/04/1700_Structure-File.pdf) · [Intercom technical details](https://www.loxone.com/enus/products/intercom/technical/) · [Home Assistant integration PR](https://github.com/ArtifexEt/Loxone-Home-Assistant/pull/4)
- **Intercom Gen. 1 and Intercom XL** have separate camera and SIP modules. Camera availability depends on the URLs exposed by the installation. The Gen. 2 conversation flow applies only to Gen. 2. [Loxone legacy intercom documentation](https://www.loxone.com/enen/kb/intercom-intercom-xl/)

- **Intercoms on another Miniserver via Trust** require that member Miniserver for media access. Connect directly to it to use the camera and audio. [Loxone Structure File](https://www.loxone.com/enen/wp-content/uploads/sites/3/2026/04/1700_Structure-File.pdf)

## Loxone 17.x changes

- Miniserver 17 uses the updated Remote Connect service. Loxone documents `connect.loxonecloud.com` for serial-number lookup and has deprecated `dns.loxonecloud.com`. On November 17, 2026, Loxone withdrew its December 1 update deadline. It recommends the security update to `17.3.11.12` or a newer release. [Miniserver API v17](https://www.loxone.com/enen/kb/api/) · [Current Loxone Remote Connect announcement](https://www.loxone.com/enus/blog/remote-connect-up-to-date-software/)
- Config 17.3 adds email MFA for Miniserver users and groups. This app's sign-in flow supports username and password. Users whose sign-in requires a second factor need the official Loxone client. [Config changelog](https://www.loxone.com/enen/support/changelog-config/)
- Config 17.1 adds a setting that lets supported Loxone apps show live video when the bell rings. The default is a still image taken at the ring, and the Gen. 2 device supports up to three simultaneous live feeds. [Intercom function block](https://www.loxone.com/enen/kb/intercom-2/) · [Config changelog](https://www.loxone.com/enen/support/changelog-config/)
- App 17.3.1 improves recovery when Gen. 2 video fails and the user starts talking. Intercom firmware 17.3.5.11 includes audio/video handling and security fixes. [App changelog](https://www.loxone.com/enen/support/changelog-smart-home-app/) · [Intercom changelog](https://www.loxone.com/enen/support/changelog-intercom/)

## Run locally

```sh
npm ci
npm run dev
```

Use `npm run build` to type-check the code and build `dist/`. Use `npm run preview` to serve that build locally. The Web Worker owns application state, persistence, Miniserver communication and intercom signaling. The page handles rendering and WebRTC browser media APIs.

## Artwork

The sign-in screen uses an original generated illustration of the Miniserver Gen. 2. [Loxone product reference](https://www.loxone.com/int/products/miniserver/)
