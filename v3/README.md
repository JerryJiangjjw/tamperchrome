# Tamper Dev v3

This directory is the Manifest V3 version of Tamper Dev. It uses an extension
service worker and `chrome.runtime.Port` messaging instead of the persistent
Manifest V2 background page.

## Build

Run `make crx_local` to create an unpacked development extension in
`crx_local`, or `make crx.zip` for the production archive. Load `crx_local`
from Chrome's **Load unpacked** control.

Use Node.js 18 or later. The Makefile includes the OpenSSL compatibility
setting required by the inherited Angular 11 build.

The extension requires Chrome 118 or later because active debugger sessions
keep the MV3 service worker alive while interception is in progress.
