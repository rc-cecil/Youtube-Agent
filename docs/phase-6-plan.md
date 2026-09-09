# Phase 6 implementation plan

Preserve phases 1–5. Extend the existing calendar/settings workflow with channel connection and publication status; retain the sole supplied-video hero. No analytics or learning implementation.

1. Add encrypted OAuth credentials, short-lived single-use OAuth state, durable YouTube publications and campaigns. Keep owner foreign keys and unique Short/publication identity.
2. Use Google's official OAuth and YouTube Data API. Request upload and read-only channel scopes; exchange and refresh tokens server-side. Use state, browser binding, PKCE, authenticated encryption and sanitized errors.
3. Snapshot a QC-ready, rights-cleared, editorially reserved Short's metadata, render and publishing time. Explicit scheduling action authorizes upload. Persist resumable session before transmitting bytes, probe offsets on recovery, never restart ambiguous completed uploads blindly.
4. Poll durable publication state independently of media queues. Reconcile remote processing/privacy/publishAt and eventual publication. Surface expired credentials, missed slots, mismatches and unavailable remote videos. Cancellation removes the remote schedule before releasing local content.
5. Display connected channel, publication progress, metadata, timestamps, actionable errors and a 30-day/90-slot campaign with factual counts. Reuse existing semantic controls and motion tokens. Respect reduced motion and keyboard input.
6. Test security, transport contracts, state transitions, isolation, retries and earlier phases. Run migrations, unit/integration/render tests, type/lint/format/build checks. Document credential setup and limitations without publishing a real video during verification.

Skill portability: the 24 skills pinned in skills-lock.json were copied from .agents/skills into the user's global Codex skills directory without overwriting existing skills. Project copies and provenance remain available.
