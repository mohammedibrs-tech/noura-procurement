// ══════════════════════════════════════════════════════════════
// إرسال طلب عرض سعر (RFQ) بالبريد الإلكتروني لكل الموردين المدخلين
// Vercel Serverless Function — تُستدعى مباشرة من المنصة عند حفظ RFQ
//
// تستخدم خدمة Resend (https://resend.com) لإرسال البريد فعلياً.
// راجع ملف الإعداد المرفق لخطوات التركيب (حساب Resend + توثيق النطاق).
// ══════════════════════════════════════════════════════════════

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL; // مثال: "إدارة المشتريات <procurement@yourcompany.sa>"
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET; // اختياري — حماية بسيطة من إرسال غير مصرّح

// يبني محتوى البريد بصيغة HTML مطابقة لتنسيق طلب عرض السعر بالمنصة
function buildEmailHTML(rfq, vendorName) {
  const rows = (rfq.rows || [])
    .map(
      (r) => `
      <tr>
        <td style="border:1px solid #ccc;padding:8px;text-align:center;">${r.num || ''}</td>
        <td style="border:1px solid #ccc;padding:8px;">${r.item || ''}</td>
        <td style="border:1px solid #ccc;padding:8px;text-align:center;">${r.qty || ''}</td>
        <td style="border:1px solid #ccc;padding:8px;">${r.notes || ''}</td>
      </tr>`
    )
    .join('');

  return `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111;">
    <div style="background:#2E9896;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <div style="font-size:16px;font-weight:700;">طلب عرض سعر (RFQ)</div>
      <div style="font-size:12px;opacity:.9;margin-top:4px;">الرقم المرجعي: ${rfq.refNum || '—'}</div>
    </div>
    <div style="border:1px solid #E2E8F0;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
      <p style="font-size:13px;line-height:1.8;">
        السادة / <strong>${vendorName}</strong> المحترمين،<br><br>
        نفيدكم أننا بصدد طلب الأصناف/الخدمات الموضحة أدناه، لذا نأمل التكرم بإرسال عرض سعر يوضح كافة التفاصيل الخاصة بها.
      </p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:12px;">
        <thead>
          <tr style="background:#F8FAFB;">
            <th style="border:1px solid #ccc;padding:8px;">م</th>
            <th style="border:1px solid #ccc;padding:8px;">الصنف</th>
            <th style="border:1px solid #ccc;padding:8px;">الكمية</th>
            <th style="border:1px solid #ccc;padding:8px;">ملاحظات</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        rfq.notes
          ? `<p style="font-size:12px;background:#F8FAFB;padding:10px 12px;border-radius:6px;"><strong>تفاصيل إضافية:</strong> ${rfq.notes}</p>`
          : ''
      }
      <p style="font-size:12px;color:#64748B;margin-top:20px;">
        تاريخ الطلب: ${rfq.date || '—'}<br>
        الجهة الطالبة: ${rfq.company || '—'}
      </p>
    </div>
  </div>`;
}

async function sendOneEmail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Resend failed for ${to}: ${r.status} ${errText}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  if (!RESEND_API_KEY || !FROM_EMAIL) {
    return res.status(500).json({
      ok: false,
      error: 'متغيرات البيئة ناقصة — تأكد من RESEND_API_KEY و FROM_EMAIL بإعدادات Vercel',
    });
  }

  // حماية اختيارية: لو ضبطت APP_SHARED_SECRET بالبيئة، لازم يجي نفسه بالطلب
  if (APP_SHARED_SECRET) {
    const provided = req.headers['x-app-secret'] || '';
    if (provided !== APP_SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const { rfq } = req.body || {};
  if (!rfq || !Array.isArray(rfq.vendors) || !rfq.vendors.length) {
    return res.status(400).json({ ok: false, error: 'لا يوجد موردون بالطلب' });
  }

  let sent = 0;
  const errors = [];

  for (const vendor of rfq.vendors) {
    if (!vendor.email) continue;
    try {
      const html = buildEmailHTML(rfq, vendor.name || vendor.email);
      await sendOneEmail(
        vendor.email,
        `طلب عرض سعر ${rfq.refNum ? '— ' + rfq.refNum : ''}`,
        html
      );
      sent++;
    } catch (err) {
      console.error('send-rfq: failed for', vendor.email, err);
      errors.push({ email: vendor.email, error: String(err.message || err) });
    }
  }

  if (sent === 0) {
    return res.status(500).json({ ok: false, error: 'فشل الإرسال لكل الموردين', details: errors });
  }

  return res.status(200).json({ ok: true, sent, total: rfq.vendors.length, errors });
}
