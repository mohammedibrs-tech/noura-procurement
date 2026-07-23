// ══════════════════════════════════════════════════════════════
// مساعد مدير المشتريات — Agent يومي تلقائي
// Vercel Serverless Function
//
// الترتيب المنفَّذ هنا:
//   Scheduler (Vercel Cron) → يستدعي هذا الملف
//   → يجلب العقود من Supabase
//   → يفحص العقود الحرجة (تنتهي خلال 90 يوم)
//   → يبحث بالويب عن موردين بدلاء + تحليل سوق (عبر Claude + web_search)
//   → ينشئ ملخص توصيات تنفيذي
//   → يحفظ كل النتائج بجدول procurement_agent_runs
//
// المنصة (index.html) تقرأ آخر صف من هذا الجدول وتعرضه بخانة
// "مساعد مدير المشتريات" — لا تنفّذ أي بحث هي نفسها.
// ══════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // anon أو service_role — شوف README
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // اختياري لكن مستحسن بقوة

// ── حساب الأيام المتبقية على انتهاء عقد ──
function daysLeft(endDate) {
  if (!endDate) return null;
  const diff = new Date(endDate) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ── طلبات Supabase (REST مباشر، بدون مكتبات خارجية) ──
async function sbSelect(table, query = 'select=*') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase INSERT ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── استدعاء Claude API (مع أو بدون بحث ويب) ──
async function callClaude({ system, prompt, useWebSearch = false }) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Claude API failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// يحاول يستخرج أول كتلة JSON صالحة من رد نصي (Claude أحياناً يحيط الرد بشرح)
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // ── حماية الـ endpoint: لازم يجي من Vercel Cron أو بسر معروف ──
  // يقبل السر إما كـ Header (Authorization: Bearer ...) وإما كـ query param (?secret=...)
  // القبول بالـ query param مقصود لتسهيل الاختبار اليدوي من شريط عنوان المتصفح مباشرة
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    const querySecret = req.query && req.query.secret;
    const okHeader = authHeader === `Bearer ${CRON_SECRET}`;
    const okQuery = querySecret === CRON_SECRET;
    if (!okHeader && !okQuery) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'متغيرات البيئة ناقصة — تأكد من SUPABASE_URL و SUPABASE_KEY و ANTHROPIC_API_KEY بإعدادات Vercel',
    });
  }

  try {
    // ── 1) جلب العقود من Supabase (مخزّنة كـ {contract_id, data: JSON-string}) ──
    const contractRows = await sbSelect('procurement_contracts', 'select=data');
    const contracts = contractRows
      .map((r) => {
        try {
          return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // ── 2) فحص العقود الحرجة (تنتهي خلال 90 يوماً) ──
    const critical = contracts
      .map((c) => ({ c, days: daysLeft(c.end) }))
      .filter((x) => x.days !== null && x.days <= 90)
      .sort((a, b) => a.days - b.days);

    // ── 3) لكل عقد حرج (أعلى 5 إلحاحاً فقط — لضبط التكلفة والوقت) ──
    //      ابحث بالويب عن موردين بدلاء + ملاحظة سوق
    const supplierSuggestions = [];
    const marketNotes = [];

    for (const item of critical.slice(0, 5)) {
      const { c, days } = item;
      const prompt = `أنت محلل مشتريات خبير بالسوق السعودي. العقد التالي على وشك الانتهاء:
- المورد الحالي: ${c.vendor || 'غير محدد'}
- نوع الخدمة/العقد: ${c.type || 'غير محدد'}
- القيمة السنوية التقريبية: ${c.annual || (c.monthly ? c.monthly * 12 : 0)} ريال سعودي
- الأيام المتبقية على الانتهاء: ${days}

ابحث بالإنترنت عن 3 إلى 5 موردين بديلين حقيقيين بالسوق السعودي لنفس نوع الخدمة، واذكر لكل واحد اسمه الحقيقي وموقعه الإلكتروني إن وجد وسبب ترشيحه. اذكر أيضاً أي تطورات حديثة بهذا السوق (تغير أسعار، منافس جديد، إلخ).

مهم جداً: أجب بصيغة JSON صِرف فقط، بدون أي نص قبله أو بعده، بالشكل التالي بالضبط:
{"alternatives":[{"name":"...","website":"...","reason":"..."}],"market_note":"..."}`;

      try {
        const raw = await callClaude({
          system:
            'أنت محلل مشتريات خبير يبحث بالإنترنت فعلياً ويرجّع نتائج حقيقية ودقيقة بصيغة JSON فقط، بدون أي اختلاق لمعلومات غير مؤكدة.',
          prompt,
          useWebSearch: true,
        });
        const parsed = extractJSON(raw);
        if (parsed) {
          supplierSuggestions.push({
            contract_vendor: c.vendor,
            contract_type: c.type,
            days_left: days,
            alternatives: parsed.alternatives || [],
          });
          if (parsed.market_note) {
            marketNotes.push({ vendor: c.vendor, note: parsed.market_note });
          }
        } else {
          supplierSuggestions.push({
            contract_vendor: c.vendor,
            days_left: days,
            error: 'تعذّر تحليل رد البحث كـ JSON',
          });
        }
      } catch (err) {
        supplierSuggestions.push({
          contract_vendor: c.vendor,
          days_left: days,
          error: String(err.message || err),
        });
      }
    }

    // ── 4) ملخص تنفيذي نهائي ──
    const summaryPrompt = `لخّص التحليل التالي بأسلوب تنفيذي موجز (فقرتين كحد أقصى) موجّه لمدير المشتريات، بالعربية:

عدد العقود الحرجة (تنتهي خلال 90 يوم): ${critical.length}
تفاصيلها: ${critical.map((x) => `${x.c.vendor} (${x.days} يوم متبقي)`).join('، ') || 'لا يوجد'}

نتائج البحث عن موردين بدلاء:
${JSON.stringify(supplierSuggestions, null, 2)}`;

    const summary = await callClaude({
      system: 'أنت نائب مدير مشتريات تكتب ملخصاً تنفيذياً دقيقاً وموجزاً بالعربية، بدون مقدمات.',
      prompt: summaryPrompt,
      useWebSearch: false,
    });

    // ── 5) احفظ كل شي بجدول procurement_agent_runs ──
    const savedRun = await sbInsert('procurement_agent_runs', {
      run_at: new Date().toISOString(),
      critical_contracts: critical.map((x) => ({
        vendor: x.c.vendor,
        type: x.c.type,
        end: x.c.end,
        days_left: x.days,
        annual: x.c.annual || (x.c.monthly ? x.c.monthly * 12 : 0),
      })),
      supplier_suggestions: supplierSuggestions,
      market_notes: marketNotes,
      summary,
      status: 'ok',
    });

    return res.status(200).json({ ok: true, run: savedRun });
  } catch (err) {
    console.error('procurement-agent run failed:', err);
    // حاول تسجّل الخطأ نفسه بالجدول حتى لو فشل التشغيل بالكامل
    try {
      await sbInsert('procurement_agent_runs', {
        run_at: new Date().toISOString(),
        status: 'error',
        error: String(err.message || err),
      });
    } catch (_) {
      /* تجاهل — لو حتى تسجيل الخطأ فشل، خلاص ما فيه شي إضافي نسويه */
    }
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
