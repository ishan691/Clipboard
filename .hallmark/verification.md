# CLIPBOARD UI redesign

UI only. LiquidVault branding, API contracts, transfer validation, upload workers, retention, and destructive-action confirmation are preserved.

The Files tab shows files and ZIP archives; Text shows text records. Both composers remain mounted to preserve drafts and staged files. Tab selection uses the URL hash, arrow keys, Home and End. Workspace counts use real active records.

Checks completed: Hallmark static sweep (0 FAIL, 0 REFLEX, 0 WARN), eight TSX files parsed with global esbuild, internal imports and CSS bundled with external packages excluded, browser smoke script syntax checked, git diff --check.

Checks blocked: npm ci failed with ENOTFOUND registry.npmjs.org. Offline installation failed with ENOTCACHED. No local node_modules or puppeteer-core. The global TypeScript 7 compiler rejects the existing baseUrl configuration; no project config was changed to accommodate that global tool. Full type checking, production build, browser screenshots and live transfer behavior remain unverified.

To finish verification on a connected machine: run `npm ci`, `npm run build`, then `npm run dev`. Open `/tests/ui-smoke.html` and run its checks. The smoke page exercises tab links, keyboard focus, draft preservation and the 390px layout without sending or deleting transfers. Check actual file and text transfers against the existing backend separately.

Copy tightened: promotional intro replaced by “Transfer workspace”; numbered uppercase panel labels replaced by “Send files” / “Send text” and “Recent files” / “Recent text”; queue labels use sentence case; the drop-zone limit now explicitly says “per file”. The shared-workspace visibility notice is unchanged.

No session migration or handoff switch was requested or performed. Implementation state and verification limits are recorded here for continuation.
