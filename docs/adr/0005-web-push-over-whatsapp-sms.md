# 0005. Web Push instead of WhatsApp or SMS for the MVP
Date: 2026-11-16
Status: Accepted

## Context

The point of a virtual queue is that customers can leave the shop ("wait at the café next door") and still be told when it's their turn. That needs a message that reaches a phone whose browser tab may be in the background or closed.

In Brazil, WhatsApp is the channel people actually read. But the target customers are small shops paying little or nothing, the product is a portfolio project, and every channel has a cost and an approval process.

## Options considered

1. **WhatsApp Business Platform (official API)**
   - Pros: the channel customers expect in Brazil; very high read rates.
   - Cons: requires a verified Meta business account per sender, pre-approved message templates, and a per-conversation fee; onboarding takes days. Unofficial gateways (automating a personal WhatsApp) break WhatsApp's terms and get numbers banned.
2. **SMS** (via Twilio, Zenvia, etc.)
   - Pros: works on any phone, no app or permission.
   - Cons: costs per message (meaningful for a free tier); needs the customer's phone number, which is more personal data to protect; sender registration rules; delivery delays on some carriers.
3. **Email**
   - Pros: free or nearly free; no permission prompt.
   - Cons: too slow and too easy to miss for "it's your turn".
4. **Web Push** (W3C Push API, VAPID)
   - Pros: free; no account or phone number: the subscription is an opaque endpoint tied to one browser; works with the tab closed (on Android and desktop); standard, provider-neutral (FCM, Mozilla, Apple push services all speak it).
   - Cons: needs an explicit permission prompt; on iPhone it only works once the site is added to the home screen (iOS 16.4+); some users decline or block notifications.

## Decision

Web Push for the MVP, behind a `Notifier` interface, with the open ticket page as the always-working fallback (it updates live over SSE, ADR-0002).

- **Two notifications** (SPEC §8): "you're almost up" once per ticket, when at most `notify_when_ahead` people are ahead; "it's your turn" once **per call** (a customer pushed back and called again is told again). Dedupe keys: `almost` and `called:{calledAtMs}`.
- **Two dedupe layers**: BullMQ job ids (`push-{ticket}-{kind}-…`) make a duplicate enqueue a no-op while the job is retained; a unique partial index on `ticket_events (ticket_id, payload->>'kind') WHERE type = 'notified'` makes a second record impossible, and the worker checks it before sending.
- **Who detects "almost up"**: one debounced `notify-scan` job per queue (BullMQ deduplication, 300 ms window), run by the worker, so API replicas don't each send their own copy and a burst of changes is one scan.
- **Reliability**: `send-push` retries 3 times with exponential backoff on transient errors; `404/410 Gone` deletes the subscription. Messages have a 15-minute TTL: a late "your turn" is worse than none.
- **Privacy**: subscriptions are deleted as soon as the ticket reaches a final status; customer emails 30 days after (daily retention job). No phone numbers are collected.
- **iOS**: a minimal manifest and icons, and an in-page hint on iPhone Safari: "Share → Add to Home Screen" to get notifications. Said plainly in the README.

## Consequences

- Easier: no per-message cost, no business verification, no phone numbers; works the same for every tenant from day one.
- Harder: some customers won't grant permission, and iPhone users must install the site first. The live ticket page covers them, but they must keep it open.
- The `Notifier` interface is where email (Resend, v1.1) plugs in, and where WhatsApp would go if a tenant brings an approved business account: the jobs decide *what* and *when*, not *how*.
- Revisit if tenants ask for WhatsApp and are willing to complete Meta's verification and pay per conversation; it would be a per-tenant opt-in channel next to Web Push, not a replacement.
