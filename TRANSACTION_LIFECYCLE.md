# Bixcart Transaction Lifecycle & Escrow System

## Overview

The Bixcart marketplace now enforces a complete escrow-based transaction lifecycle with automatic deadlines, seller acceptance windows, and profile health penalties. This protects both buyers and sellers while ensuring platform trust.

---

## Complete Transaction Flow

### Phase 1: Payment & Escrow Hold (Immediate)

**What Happens:**
1. Buyer adds item to cart and completes checkout via Paystack
2. Payment verified via Paystack API
3. Order created with:
   - `status = 'paid'`
   - `escrow_status = 'held'`
   - `response_deadline_at = now + 6 hours`
   - `delivery_deadline_at = now + [listing's delivery_window]`
   - Unique escrow verification code generated

4. Seller's listing:
   - Moves from `status='active'` → `status='pending'` (hidden from marketplace)
   - Funds remain under Bixcart's escrow control in the Bixcart/Paystack merchant flow; seller payout is NOT initiated at checkout

5. **Seller receives notifications:**
   - Push notification: "Payment held in escrow — fulfill within deadline"
   - Email: Includes delivery window, order ID, listing title
   - Chat link opens automatically

**Timeline:** Immediate (< 1 second)

---

### Phase 2: Seller Response Window (6 Hours)

**Option A: Seller Accepts Order**

```
POST /api/orders/:id/accept
```

1. Seller clicks "Accept" in chat or dashboard
2. System validates `response_deadline_at` not elapsed
3. Order status → `'confirmed'`
4. `seller_accepted_at` timestamp recorded
5. Buyer notified: "Seller accepted! Delivery must happen by [date/time]"
6. Delivery window countdown starts (6h / 12h / 1d / 3d / 7d)

**Option B: Seller Does NOT Respond (6 hours pass)**

1. Automatic refund triggered
2. Buyer receives email: "Refund issued — seller didn't respond in time"
3. Listing re-enabled → `status='active'` (visible again)
4. Order marked `status='cancelled'`, `escrow_status='cancelled'`
5. Buyer can rate seller (penalizes profile_health)
6. Funds returned to buyer's Paystack account

**Option C: Seller Explicitly Declines**

- Future enhancement: Allow seller to decline and unlock listing

**Timeline:** Buyer can proceed after 6 hours if no response

---

### Phase 3: Delivery & Fulfillment (Variable: 6h to 7d)

**What Happens During This Window:**

1. Seller and buyer coordinate delivery via chat:
   - Same hostel? → Pickup arrangement
   - Different hostel? → Delivery logistics discussion

2. Buyer location info from order:
   - Full name, phone, address, campus, special notes

3. Seller delivery info:
   - Hostel name & room number (if on campus)
   - OR shop name & shop number (if off-campus)

---

### Phase 4: Seller Fulfills Order

```
POST /api/orders/:id/mark-shipped
```

**Seller Action:**
- Clicks "Mark as Shipped" or "Fulfilled"
- System checks: Is `delivery_deadline_at` still in future?
  - ✓ Yes → Proceed
  - ✗ No → Reject with message "Deadline passed, auto-refunded"

**Order Updated:**
- `status = 'fulfilled'`
- `delivered_at = now`
- Verification code shared with buyer (via chat)

**Buyer Notification:**
- "Seller fulfilled your order — confirm the verification code"

**Timeline:** Within the chosen delivery window (or order fails)

---

### Phase 5: Buyer Confirms & Escrow Releases

```
POST /api/orders/:id/confirm-delivery
Body: { code: "XXXX-XXXX" }
```

**Buyer Action:**
- Confirms they received the item
- Enters the verification code from seller

**System Validates:**
- Is `delivery_deadline_at` still in future?
  - ✓ Yes → Release escrow
  - ✗ No → Auto-refund (deadline passed)
- Does code match escrow_code?
  - ✓ Yes → Proceed
  - ✗ No → Reject, ask to retry

**If Code Matches:**
1. Escrow released: `escrow_status = 'released'`
2. Order status → `'completed'`
3. Listing status → `'sold'`
4. Payout initiated:
   - Bixcart commission (seller's current 7%→5.5% tier) is deducted
   - Paystack processing fee is calculated from the verified transaction and shared 50/50 between Bixcart and seller
   - Seller's remaining entitlement is transferred to the seller's verified Paystack transfer recipient
   - The seller is notified when the transfer is initiated

5. Seller notified: "Escrow released! Payout of ₦X sent to your bank"
6. Chat prompt: "Rate this transaction"

**Timeline:** Immediate (< 1 second for release)

---

### Phase 6: Rating & Profile Health

```
POST /api/orders/:id/rate
Body: { rating: 5, review: "Great seller!" }
```

**Buyer Rates Seller:**
- Star rating (1–5)
- Optional review text

**Profile Health Calculation:**

| Rating | Health Change |
|--------|---------------|
| 5 ⭐   | +5            |
| 4 ⭐   | +5            |
| 3 ⭐   | 0 (neutral)   |
| 2 ⭐   | -8            |
| 1 ⭐   | -8            |

**Profile Health Impact:**
- Range: 0–100
- Lower health → Lower visibility in search results
- Affects seller discoverability and trust score

**Example:**
- Seller starts with health = 100
- Receives a 1-star rating → health = 92
- Receives three 2-star ratings → health = 68
- Must get 4–5 star ratings to recover

---

## Delivery Window Options

Seller selects when creating listing:

| Option | Time | Use Case |
|--------|------|----------|
| 6h     | 6 hours | Quick same-day pickup in hostel |
| 12h    | 12 hours | Next-day pickup |
| 1d     | 1 day | Standard (default) |
| 3d     | 3 days | Furniture, large items, arranged logistics |
| 7d     | 7 days | Items requiring shipping across campus |

---

## Fee Structure

**Listing Creation:** FREE

**When Item Sells:**
- Bixcart commission: **7% → 5.5%**, based on the seller's permanent successful-sales tier
- Paystack processing fee: **shared 50/50 between Bixcart and seller**
- Example: Item sells for ₦10,000
  - Bixcart commission depends on the seller's tier
  - The verified Paystack processing fee is split 50/50
  - Seller receives the remaining amount only after escrow is released
  - Buyer pays: ₦10,000 (no extra fee)

---

## Notification Timeline

### Seller Receives:

| Time | Via | Message |
|------|-----|---------|
| Immediately | Push + Email | Payment held, delivery deadline |
| 5h 55m (if no response) | Push | Respond soon or order auto-refunds |
| On acceptance | Push | Delivery window countdown |
| On escrow release | Push + Email | Payout sent to bank |

### Buyer Receives:

| Time | Via | Message |
|------|-----|---------|
| Immediately | In-app | Order created, awaiting seller response |
| After 6h (if no response) | Email | Refund issued |
| On acceptance | Chat | Seller ready, coordinate delivery |
| On fulfillment | Chat | Seller fulfilled, confirm code |
| On escrow release | In-app | Payout released, rate seller |

---

## Error Cases & Auto-Refunds

### Seller Doesn't Respond (6 hours)
- Status: `'cancelled'`
- Escrow: `'cancelled'`
- Listing: Re-enabled (`'active'`)
- Buyer: Auto-refunded
- Email: Sent to buyer

### Seller Doesn't Fulfill (Delivery Window Passes)
- Buyer tries to confirm code
- API rejects: "Deadline passed, auto-refunded"
- Status: `'cancelled'`
- Listing: Re-enabled
- Buyer: Auto-refunded
- Seller: No payout is initiated

### Invalid Verification Code
- Buyer enters wrong code
- API rejects: "Code incorrect"
- Buyer retries (unlimited attempts until deadline)

---

## API Endpoints Summary

### For Sellers:

```
POST   /api/orders/:id/accept               Accept order (6h window)
POST   /api/orders/:id/mark-shipped         Fulfill order
GET    /api/orders/selling                  View pending/completed orders
GET    /api/orders/stats                    Seller dashboard stats
```

### For Buyers:

```
POST   /api/orders/checkout                 Pay for cart
POST   /api/orders/:id/confirm-delivery     Verify code & release escrow
POST   /api/orders/:id/rate                 Rate seller (affects profile_health)
GET    /api/orders/buying                   View purchase history
```

### For Admin:

```
POST   /api/orders/:id/resolve              Manually cancel/complete order
GET    /api/admin/*                         Dispute & escrow management
```

---

## Key Features

✅ **6-hour seller response window** — Protects buyers from hanging orders  
✅ **Variable delivery deadlines** — Sellers choose 6h–7d based on item type  
✅ **Automatic refunds** — Triggered on timeout, no manual intervention  
✅ **Push + Email notifications** — Keeps both parties in sync  
✅ **Profile health system** — Poor ratings damage seller credibility  
✅ **Hostel-aware delivery** — Same hostel = free pickup, different = arranged  
✅ **Escrow verification codes** — Buyer confirms receipt before payout  
✅ **Payout via Paystack** — Automatic bank transfers within 24–48h  
✅ **Edit lock** — Listings locked after 90 minutes to prevent fraud  

---

## Next Steps (Future Enhancements)

- [ ] Seller dispute button during delivery window
- [ ] Admin dashboard for escrow disputes
- [ ] Seller counter-offer on delivery window
- [ ] Chat-based delivery photo verification
- [ ] Cancellation reason analytics
- [ ] Refund reason tracking for seller profile

---

**Document Version:** 1.0  
**Last Updated:** August 17, 2026  
**System Status:** Ready for QA testing
