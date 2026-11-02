// Acme Notes - billing helper (not wired into any page yet, but it is served from /assets/js/billing.js).
// DEMO BUG 5 (intentional, see DEMO-BUG-5.md): a Stripe *secret* key in front-end code. The value is fake: it uses
// Anvil's demo-key format (sk_anvildemo_...), which Anvil's secret scanner flags like a live Stripe key but which is
// not a real Stripe format, so GitHub push protection and other scanners leave it alone.
// The fix is to call Stripe from a server route that reads STRIPE_SECRET_KEY from the environment.
const STRIPE_KEY = 'sk_anvildemo_0000fake0000NOTaREALkey00';

export async function startCheckout(plan) {
  // a front-end call with a secret key: anyone who opens DevTools can copy it
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ mode: 'subscription', 'line_items[0][price]': plan, 'line_items[0][quantity]': '1' }),
  });
  return r.json();
}
