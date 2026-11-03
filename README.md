# WAKUKU · frozen 770d runtime release

This is the user-authorized public runtime package for the invitation preview at https://fslviul4ta14.app.stg.medeo.ai/index.html?release=770d4b65cb8b . Release identity: `wakuku-invite-770d4b65cb8b`; UI: `annie-a8204e1a5209`.

Use Node 22 or later. Run `npm ci --omit=dev --ignore-scripts`, `npm run build`, then `npm start`. mEnv uses the included `medeo.json` and the existing server-side environment. Credentials remain in the host secret store.

The 108,173,784-byte Godot pack exceeds GitHub's 100 MiB file limit, so `pack-parts/` stores three pieces of at most 48 MiB. The build joins them locally and verifies every part and the complete SHA-256 `770d4b65cb8bac364ca3f51fdb0a49ffc2293676ea53acbdb129ca21889f1d0e` before installing `dist/companion-770d4b65cb8b.pck`. The assembled pack is ignored by Git. Server, cloud gateway, game, UI and packaged voice semantics match the reviewed frozen bundle.

This is an invitation preview. The hood flap can intersect the left sleeve (reported peak 36.2 mm); thumb/wrist can cross the tray rim in one reach pose. Final visual signoff, physical-phone acceptance and human microphone action/barge-in remain unverified. Keep the included third-party notices and licences. This directory contains deployed runtime assets and excludes credentials, editor sources, screenshots, photos, conversation history and model weights.

The current voice revision uses the user-selected original local child profile A for all 15 cached interactions; dynamic speech uses the registered SeedTTS Holly child preset. These are separate synthesis engines, and identical speaker identity is not claimed. The API credit limit remains unchanged.
