import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Fetches a single payment by ID directly from Razorpay.
async function fetchPaymentById(paymentId, auth) {
  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.description || 'Payment ID not found on Razorpay');
  return data;
}

// Fetches all payments for an order and returns the captured one, if any.
async function fetchCapturedPaymentForOrder(orderId, auth) {
  const res = await fetch(`https://api.razorpay.com/v1/orders/${orderId}/payments`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.description || 'Order ID not found on Razorpay');
  const captured = (data.items || []).find((p) => p.status === 'captured');
  if (!captured) return null;
  return captured;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID');
    const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const auth = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);

    const { razorpay_payment_id, razorpay_order_id, booking } = await req.json();

    if (!booking || !booking.date || !booking.court || !Array.isArray(booking.slot_hours) || booking.slot_hours.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing booking details' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Step 1: get the real payment record directly from Razorpay — never trust client input alone.
    let payment = null;
    if (razorpay_payment_id) {
      payment = await fetchPaymentById(razorpay_payment_id, auth);
    } else if (razorpay_order_id) {
      payment = await fetchCapturedPaymentForOrder(razorpay_order_id, auth);
    } else {
      return new Response(JSON.stringify({ error: 'Provide a Razorpay Payment ID or Order ID' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!payment) {
      return new Response(JSON.stringify({ error: 'No completed payment found yet for this order. If money was deducted, please wait a minute and try again.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (payment.status !== 'captured') {
      return new Response(JSON.stringify({ error: `Payment status is "${payment.status}", not captured. Nothing has been charged successfully yet.` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 2: idempotency — if this payment was already reconciled/booked, just return that booking.
    const { data: already, error: alreadyErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('payment_id', payment.id)
      .maybeSingle();
    if (alreadyErr) throw new Error(alreadyErr.message);
    if (already) {
      return new Response(JSON.stringify({ success: true, already_existed: true, booking: already }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 3: amount sanity check — the real captured amount (paise) must match what this
    // booking claims was paid online, so a mistyped/mismatched booking can't be forced through.
    const expectedPaise = Math.round(Number(booking.advance_amount) * 100);
    if (payment.amount !== expectedPaise) {
      return new Response(JSON.stringify({
        error: `Amount mismatch: Razorpay shows ₹${payment.amount / 100} captured, but this booking expects ₹${booking.advance_amount}. Double-check the details before retrying.`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 4: make sure the slot hasn't since been taken by a different confirmed booking.
    const { data: conflicts, error: conflictErr } = await supabase
      .from('bookings')
      .select('id')
      .eq('date', booking.date)
      .eq('court', booking.court)
      .in('slot_hour', booking.slot_hours)
      .eq('status', 'confirmed');
    if (conflictErr) throw new Error(conflictErr.message);
    if (conflicts && conflicts.length > 0) {
      return new Response(JSON.stringify({
        error: 'This slot is already booked by someone else. The payment is real and safe (visible in Razorpay) — please pick a different slot and contact the customer to rebook.',
        slot_taken: true
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 5: create the booking, tied to the verified payment/order.
    const bookingId = booking.id || ('C57' + Date.now().toString().slice(-6));
    const row = {
      ...booking,
      id: bookingId,
      payment_id: payment.id,
      order_id: payment.order_id,
      status: 'confirmed',
      created_at: booking.created_at || new Date().toISOString(),
    };

    const { data: inserted, error: insertErr } = await supabase
      .from('bookings')
      .insert([row])
      .select()
      .single();
    if (insertErr) throw new Error(insertErr.message);

    return new Response(JSON.stringify({ success: true, already_existed: false, booking: inserted }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
