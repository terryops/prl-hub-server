// Notification copy, localized server-side: the app has an in-app language
// switch that APNs loc-keys would ignore (they follow the SYSTEM language), so
// the app reports its resolved language and the text is built here.
// Languages mirror Sources/*.lproj (the app's `AppLanguage`); a language missing here is
// notified in English.

import { ANON } from "./pools.js";

export const LANGS = ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"];

/// "$0.88", "$0.90", "$12.35" — always 2 decimals, matching the app (the wallet's
/// price chip and the alert list).
export function fmtUSD(v) {
  return "$" + v.toFixed(2);
}

const win = (w, m5, h1, h24) => (w === 300 ? m5 : w === 3600 ? h1 : h24);

const pct = (v) => Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2).replace(/\.?0+$/, "") + "%";

const T = {
  en: {
    above: (x, p) => [`PRL above ${x}`, `Now ${p} — above your ${x} alert.`],
    below: (x, p) => [`PRL below ${x}`, `Now ${p} — below your ${x} alert.`],
    up: (c, w, p) => [`PRL up ${c} in ${win(w, "5 min", "1h", "24h")}`, `Now ${p}.`],
    down: (c, w, p) => [`PRL down ${c} in ${win(w, "5 min", "1h", "24h")}`, `Now ${p}.`],
    later: (hm, p) => `Triggered at ${hm} during your quiet hours. Now ${p}.`,
    test: (p) => ["Price alerts are on", `PRL is ${p}. You'll be notified when it meets your conditions.`],
  },
  "zh-Hans": {
    above: (x, p) => [`PRL 涨破 ${x}`, `现价 ${p}，已高于你设置的 ${x}。`],
    below: (x, p) => [`PRL 跌破 ${x}`, `现价 ${p}，已低于你设置的 ${x}。`],
    up: (c, w, p) => [`PRL ${win(w, "5 分钟", "1 小时", "24 小时")}上涨 ${c}`, `现价 ${p}。`],
    down: (c, w, p) => [`PRL ${win(w, "5 分钟", "1 小时", "24 小时")}下跌 ${c}`, `现价 ${p}。`],
    later: (hm, p) => `${hm} 在免打扰时段内触发，现价 ${p}。`,
    test: (p) => ["价格提醒已开启", `现价 ${p}。价格满足你设置的条件时会通知你。`],
  },
  "zh-Hant": {
    above: (x, p) => [`PRL 漲破 ${x}`, `現價 ${p}，已高於你設定的 ${x}。`],
    below: (x, p) => [`PRL 跌破 ${x}`, `現價 ${p}，已低於你設定的 ${x}。`],
    up: (c, w, p) => [`PRL ${win(w, "5 分鐘", "1 小時", "24 小時")}上漲 ${c}`, `現價 ${p}。`],
    down: (c, w, p) => [`PRL ${win(w, "5 分鐘", "1 小時", "24 小時")}下跌 ${c}`, `現價 ${p}。`],
    later: (hm, p) => `${hm} 在勿擾時段內觸發，現價 ${p}。`,
    test: (p) => ["價格提醒已開啟", `現價 ${p}。價格符合你設定的條件時會通知你。`],
  },
  ru: {
    above: (x, p) => [`PRL выше ${x}`, `Сейчас ${p} — выше вашего порога ${x}.`],
    below: (x, p) => [`PRL ниже ${x}`, `Сейчас ${p} — ниже вашего порога ${x}.`],
    up: (c, w, p) => [`PRL вырос на ${c} за ${win(w, "5 мин", "1 ч", "24 ч")}`, `Сейчас ${p}.`],
    down: (c, w, p) => [`PRL упал на ${c} за ${win(w, "5 мин", "1 ч", "24 ч")}`, `Сейчас ${p}.`],
    later: (hm, p) => `Сработало в ${hm}, в тихие часы. Сейчас ${p}.`,
    test: (p) => ["Ценовые оповещения включены", `PRL сейчас ${p}. Мы сообщим, когда цена выполнит ваши условия.`],
  },
  vi: {
    above: (x, p) => [`PRL vượt ${x}`, `Giá hiện tại ${p} — đã cao hơn mức ${x} bạn đặt.`],
    below: (x, p) => [`PRL xuống dưới ${x}`, `Giá hiện tại ${p} — đã thấp hơn mức ${x} bạn đặt.`],
    up: (c, w, p) => [`PRL tăng ${c} trong ${win(w, "5 phút", "1 giờ", "24 giờ")}`, `Giá hiện tại ${p}.`],
    down: (c, w, p) => [`PRL giảm ${c} trong ${win(w, "5 phút", "1 giờ", "24 giờ")}`, `Giá hiện tại ${p}.`],
    later: (hm, p) => `Kích hoạt lúc ${hm} trong giờ yên lặng. Giá hiện tại ${p}.`,
    test: (p) => ["Đã bật cảnh báo giá", `PRL hiện ở ${p}. Bạn sẽ được thông báo khi giá đạt điều kiện đã đặt.`],
  },
  id: {
    above: (x, p) => [`PRL di atas ${x}`, `Sekarang ${p} — di atas batas ${x} Anda.`],
    below: (x, p) => [`PRL di bawah ${x}`, `Sekarang ${p} — di bawah batas ${x} Anda.`],
    up: (c, w, p) => [`PRL naik ${c} dalam ${win(w, "5 menit", "1 jam", "24 jam")}`, `Sekarang ${p}.`],
    down: (c, w, p) => [`PRL turun ${c} dalam ${win(w, "5 menit", "1 jam", "24 jam")}`, `Sekarang ${p}.`],
    later: (hm, p) => `Terpicu pukul ${hm} saat jam tenang. Sekarang ${p}.`,
    test: (p) => ["Peringatan harga aktif", `PRL sekarang ${p}. Anda akan diberi tahu saat harga memenuhi kondisi Anda.`],
  },
  es: {
    above: (x, p) => [`PRL por encima de ${x}`, `Ahora ${p}: por encima de tu alerta de ${x}.`],
    below: (x, p) => [`PRL por debajo de ${x}`, `Ahora ${p}: por debajo de tu alerta de ${x}.`],
    up: (c, w, p) => [`PRL sube ${c} en ${win(w, "5 min", "1h", "24h")}`, `Ahora ${p}.`],
    down: (c, w, p) => [`PRL baja ${c} en ${win(w, "5 min", "1h", "24h")}`, `Ahora ${p}.`],
    later: (hm, p) => `Se activó a las ${hm}, fuera de tu horario de avisos. Ahora ${p}.`,
    test: (p) => ["Alertas de precio activadas", `PRL está en ${p}. Te avisaremos cuando se cumplan tus condiciones.`],
  },
  "pt-BR": {
    above: (x, p) => [`PRL acima de ${x}`, `Agora ${p} — acima do seu alerta de ${x}.`],
    below: (x, p) => [`PRL abaixo de ${x}`, `Agora ${p} — abaixo do seu alerta de ${x}.`],
    up: (c, w, p) => [`PRL subiu ${c} em ${win(w, "5 min", "1h", "24h")}`, `Agora ${p}.`],
    down: (c, w, p) => [`PRL caiu ${c} em ${win(w, "5 min", "1h", "24h")}`, `Agora ${p}.`],
    later: (hm, p) => `Disparou às ${hm}, no seu horário de silêncio. Agora ${p}.`,
    test: (p) => ["Alertas de preço ativados", `O PRL está em ${p}. Você receberá uma notificação quando ele atender às suas condições.`],
  },
  fr: {
    above: (x, p) => [`PRL au-dessus de ${x}`, `Actuellement ${p}, au-dessus de votre alerte à ${x}.`],
    below: (x, p) => [`PRL en dessous de ${x}`, `Actuellement ${p}, en dessous de votre alerte à ${x}.`],
    up: (c, w, p) => [`PRL en hausse de ${c} en ${win(w, "5 min", "1 h", "24 h")}`, `Actuellement ${p}.`],
    down: (c, w, p) => [`PRL en baisse de ${c} en ${win(w, "5 min", "1 h", "24 h")}`, `Actuellement ${p}.`],
    later: (hm, p) => `Déclenchée à ${hm}, hors de votre plage horaire. Actuellement ${p}.`,
    test: (p) => ["Alertes de prix activées", `Le PRL est à ${p}. Vous recevrez une notification lorsque vos conditions seront remplies.`],
  },
  de: {
    above: (x, p) => [`PRL über ${x}`, `Jetzt ${p} – über deinem Alarm bei ${x}.`],
    below: (x, p) => [`PRL unter ${x}`, `Jetzt ${p} – unter deinem Alarm bei ${x}.`],
    up: (c, w, p) => [`PRL +${c} in ${win(w, "5 Min.", "1h", "24h")}`, `Jetzt ${p}.`],
    down: (c, w, p) => [`PRL −${c} in ${win(w, "5 Min.", "1h", "24h")}`, `Jetzt ${p}.`],
    later: (hm, p) => `Um ${hm} in deiner Ruhezeit ausgelöst. Jetzt ${p}.`,
    test: (p) => ["Preisalarme sind aktiv", `PRL steht bei ${p}. Du wirst benachrichtigt, sobald deine Bedingungen erfüllt sind.`],
  },
  it: {
    above: (x, p) => [`PRL sopra ${x}`, `Ora ${p}: sopra il tuo avviso a ${x}.`],
    below: (x, p) => [`PRL sotto ${x}`, `Ora ${p}: sotto il tuo avviso a ${x}.`],
    up: (c, w, p) => [`PRL +${c} in ${win(w, "5 min", "1h", "24h")}`, `Ora ${p}.`],
    down: (c, w, p) => [`PRL −${c} in ${win(w, "5 min", "1h", "24h")}`, `Ora ${p}.`],
    later: (hm, p) => `Scattato alle ${hm}, fuori dai tuoi orari di notifica. Ora ${p}.`,
    test: (p) => ["Avvisi di prezzo attivi", `PRL è a ${p}. Riceverai una notifica quando si verificano le tue condizioni.`],
  },
  tr: {
    above: (x, p) => [`PRL ${x} üstünde`, `Şu an ${p} — ${x} alarmınızın üstünde.`],
    below: (x, p) => [`PRL ${x} altında`, `Şu an ${p} — ${x} alarmınızın altında.`],
    up: (c, w, p) => [`PRL ${c} yükseldi (${win(w, "5 dk", "1 sa", "24 sa")})`, `Şu an ${p}.`],
    down: (c, w, p) => [`PRL ${c} düştü (${win(w, "5 dk", "1 sa", "24 sa")})`, `Şu an ${p}.`],
    later: (hm, p) => `Sessiz saatlerinizde tetiklendi (${hm}). Şu an ${p}.`,
    test: (p) => ["Fiyat alarmları açık", `PRL şu an ${p}. Koşullarınız gerçekleştiğinde bildirim alırsınız.`],
  },
  ja: {
    above: (x, p) => [`PRLが${x}を上回りました`, `現在${p}。設定した${x}を上回りました。`],
    below: (x, p) => [`PRLが${x}を下回りました`, `現在${p}。設定した${x}を下回りました。`],
    up: (c, w, p) => [`PRLが${win(w, "5分", "1時間", "24時間")}で${c}上昇`, `現在${p}。`],
    down: (c, w, p) => [`PRLが${win(w, "5分", "1時間", "24時間")}で${c}下落`, `現在${p}。`],
    later: (hm, p) => `通知時間帯外の${hm}に発生しました。現在${p}。`,
    test: (p) => ["価格アラートはオンです", `PRLは現在${p}です。条件を満たすと通知します。`],
  },
  ko: {
    above: (x, p) => [`PRL ${x} 위로 상승`, `현재 ${p} — 설정한 목표가 ${x} 위로 올랐습니다.`],
    below: (x, p) => [`PRL ${x} 아래로 하락`, `현재 ${p} — 설정한 목표가 ${x} 아래로 내렸습니다.`],
    up: (c, w, p) => [`PRL ${c} 상승(${win(w, "5분", "1시간", "24시간")})`, `현재 ${p}.`],
    down: (c, w, p) => [`PRL ${c} 하락(${win(w, "5분", "1시간", "24시간")})`, `현재 ${p}.`],
    later: (hm, p) => `푸시 시간대 밖인 ${hm}에 발생한 알림입니다. 현재 ${p}.`,
    test: (p) => ["가격 알림이 켜졌습니다", `PRL 현재 ${p}. 설정한 조건에 도달하면 알려 드립니다.`],
  },
  hi: {
    above: (x, p) => [`PRL ${x} से ऊपर`, `अभी ${p} — आपके ${x} अलर्ट से ऊपर।`],
    below: (x, p) => [`PRL ${x} से नीचे`, `अभी ${p} — आपके ${x} अलर्ट से नीचे।`],
    up: (c, w, p) => [`PRL ${win(w, "5 मिनट", "1 घंटे", "24 घंटे")} में ${c} ऊपर`, `अभी ${p}।`],
    down: (c, w, p) => [`PRL ${win(w, "5 मिनट", "1 घंटे", "24 घंटे")} में ${c} नीचे`, `अभी ${p}।`],
    later: (hm, p) => `आपके शांत समय में ${hm} बजे ट्रिगर हुआ। अभी ${p}।`,
    test: (p) => ["कीमत अलर्ट चालू हैं", `PRL अभी ${p} पर है। आपकी शर्तें पूरी होते ही नोटिफ़िकेशन मिलेगा।`],
  },
  th: {
    above: (x, p) => [`PRL สูงกว่า ${x}`, `ตอนนี้ ${p} สูงกว่าราคาแจ้งเตือน ${x} ที่คุณตั้งไว้`],
    below: (x, p) => [`PRL ต่ำกว่า ${x}`, `ตอนนี้ ${p} ต่ำกว่าราคาแจ้งเตือน ${x} ที่คุณตั้งไว้`],
    up: (c, w, p) => [`PRL ขึ้น ${c} ใน ${win(w, "5 นาที", "1 ชม.", "24 ชม.")}`, `ตอนนี้ ${p}`],
    down: (c, w, p) => [`PRL ลง ${c} ใน ${win(w, "5 นาที", "1 ชม.", "24 ชม.")}`, `ตอนนี้ ${p}`],
    later: (hm, p) => `เข้าเงื่อนไขเมื่อ ${hm} ซึ่งอยู่นอกช่วงเวลาแจ้งเตือน ตอนนี้ ${p}`,
    test: (p) => ["เปิดแจ้งเตือนราคาแล้ว", `PRL อยู่ที่ ${p} ระบบจะแจ้งเตือนเมื่อราคาเข้าเงื่อนไขที่คุณตั้งไว้`],
  },
};

/// Build the APNs payload for a fired rule (or a test push when rule is null).
export function payloadFor(lang, rule, usd, change) {
  const t = T[lang] || T.en;
  const p = fmtUSD(usd);
  let title, body;
  if (!rule) [title, body] = t.test(p);
  else if (rule.kind === "above") [title, body] = t.above(fmtUSD(rule.value), p);
  else if (rule.kind === "below") [title, body] = t.below(fmtUSD(rule.value), p);
  else [title, body] = (change >= 0 ? t.up : t.down)(pct(change), rule.window, p);
  return wrap(title, body, rule, usd);
}

/// A queued alert (fired during quiet hours), pushed at the window start: the
/// title says what happened, the body when, plus the price now.
/// q: { kind, value, window, change } as stored when it fired.
export function deferredPayloadFor(lang, q, usd, hm) {
  const t = T[lang] || T.en;
  const p = fmtUSD(usd);
  let title;
  if (q.kind === "above") [title] = t.above(fmtUSD(q.value), p);
  else if (q.kind === "below") [title] = t.below(fmtUSD(q.value), p);
  else [title] = (q.change >= 0 ? t.up : t.down)(pct(q.change || 0), q.window, p);
  return wrap(title, t.later(hm, p), { id: q.rule_id, kind: q.kind }, usd);
}

// ── 掉线提醒 ─────────────────────────────────────────────────────────────────
//
// Three lines, as a notification lays them out: the title (a red or green dot, then
// the worker), the monitor's name as the subtitle, and how long as the body. A banner
// shows two lines of body, so several workers are named on one line, not one each.
//
// anon                 what a worker the pool lists without a name is called
// one(name, d)         [title, body] for a single worker; d = how long
// many(n, names, d)    several at once; d = the longest
// back / backMany      the same two for workers that are online again; d = how
//                      long the outage lasted
// still / stillMany    the reminder for workers that are still offline; d = so far
// more(n, rest)        the tail of a name list cut to NAMES_SHOWN
// units, gap, join     minutes, hours, days, and how fmtAgo spaces them
// Outside Chinese the copy says "worker", as the app does.

const W = {
  en: {
    units: ["min", "h", "d"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "unnamed",
    one: (name, d) => [`${name} offline`, `Offline for ${d}`],
    many: (n, names, d) => [`${n} workers offline`, `${names}\nLongest: ${d}`],
    back: (name, d) => [`${name} back online`, `Was offline for ${d}`],
    backMany: (n, names, d) => [`${n} workers back online`, `${names}\nLongest outage: ${d}`],
    still: (name, d) => [`${name} still offline`, `Offline for ${d}`],
    stillMany: (n, names, d) => [`${n} workers still offline`, `${names}\nLongest: ${d}`],
  },
  "zh-Hans": {
    units: ["分钟", "小时", "天"], sep: "、", more: (n) => ` 等 ${n} 台`, anon: "未命名",
    one: (name, d) => [`${name} 掉线`, `已离线 ${d}`],
    many: (n, names, d) => [`${n} 台矿机掉线`, `${names}\n最长已离线 ${d}`],
    back: (name, d) => [`${name} 恢复上线`, `共离线 ${d}`],
    backMany: (n, names, d) => [`${n} 台矿机恢复上线`, `${names}\n最长离线 ${d}`],
    still: (name, d) => [`${name} 仍未恢复`, `已离线 ${d}`],
    stillMany: (n, names, d) => [`${n} 台矿机仍未恢复`, `${names}\n最长已离线 ${d}`],
  },
  "zh-Hant": {
    units: ["分鐘", "小時", "天"], sep: "、", more: (n) => ` 等 ${n} 台`, anon: "未命名",
    one: (name, d) => [`${name} 離線`, `已離線 ${d}`],
    many: (n, names, d) => [`${n} 台礦機離線`, `${names}\n最長已離線 ${d}`],
    back: (name, d) => [`${name} 恢復上線`, `共離線 ${d}`],
    backMany: (n, names, d) => [`${n} 台礦機恢復上線`, `${names}\n最長離線 ${d}`],
    still: (name, d) => [`${name} 仍未恢復`, `已離線 ${d}`],
    stillMany: (n, names, d) => [`${n} 台礦機仍未恢復`, `${names}\n最長已離線 ${d}`],
  },
  ru: {
    units: ["мин", "ч", "дн"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "без имени",
    one: (name, d) => [`${name} офлайн`, `Не в сети ${d}`],
    many: (n, names, d) => [`Воркеров офлайн: ${n}`, `${names}\nДольше всех: ${d}`],
    back: (name, d) => [`${name} снова в сети`, `Был не в сети ${d}`],
    backMany: (n, names, d) => [`Воркеров снова в сети: ${n}`, `${names}\nДольше всех: ${d}`],
    still: (name, d) => [`${name} всё ещё офлайн`, `Не в сети ${d}`],
    stillMany: (n, names, d) => [`Воркеров всё ещё офлайн: ${n}`, `${names}\nДольше всех: ${d}`],
  },
  vi: {
    units: ["phút", "giờ", "ngày"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "không tên",
    one: (name, d) => [`${name} ngoại tuyến`, `Đã ngoại tuyến ${d}`],
    many: (n, names, d) => [`${n} worker ngoại tuyến`, `${names}\nLâu nhất: ${d}`],
    back: (name, d) => [`${name} trực tuyến trở lại`, `Đã ngoại tuyến trong ${d}`],
    backMany: (n, names, d) => [`${n} worker trực tuyến trở lại`, `${names}\nLâu nhất: ${d}`],
    still: (name, d) => [`${name} vẫn ngoại tuyến`, `Đã ngoại tuyến ${d}`],
    stillMany: (n, names, d) => [`${n} worker vẫn ngoại tuyến`, `${names}\nLâu nhất: ${d}`],
  },
  id: {
    units: ["mnt", "jam", "hr"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "tanpa nama",
    one: (name, d) => [`${name} offline`, `Offline selama ${d}`],
    many: (n, names, d) => [`${n} worker offline`, `${names}\nTerlama: ${d}`],
    back: (name, d) => [`${name} kembali online`, `Sempat offline selama ${d}`],
    backMany: (n, names, d) => [`${n} worker kembali online`, `${names}\nTerlama: ${d}`],
    still: (name, d) => [`${name} masih offline`, `Offline selama ${d}`],
    stillMany: (n, names, d) => [`${n} worker masih offline`, `${names}\nTerlama: ${d}`],
  },
  es: {
    units: ["min", "h", "d"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "(sin nombre)",
    one: (name, d) => [`${name} sin conexión`, `Sin conexión desde hace ${d}`],
    many: (n, names, d) => [`${n} workers sin conexión`, `${names}\nTiempo máximo: ${d}`],
    back: (name, d) => [`${name} de nuevo en línea`, `Estuvo sin conexión ${d}`],
    backMany: (n, names, d) => [`${n} workers de nuevo en línea`, `${names}\nDesconexión más larga: ${d}`],
    still: (name, d) => [`${name} sigue sin conexión`, `Sin conexión desde hace ${d}`],
    stillMany: (n, names, d) => [`${n} workers siguen sin conexión`, `${names}\nTiempo máximo: ${d}`],
  },
  "pt-BR": {
    units: ["min", "h", "d"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "sem nome",
    one: (name, d) => [`${name} offline`, `Offline há ${d}`],
    many: (n, names, d) => [`${n} workers offline`, `${names}\nMaior tempo offline: ${d}`],
    back: (name, d) => [`${name} online de novo`, `Ficou offline por ${d}`],
    backMany: (n, names, d) => [`${n} workers online de novo`, `${names}\nMaior tempo offline: ${d}`],
    still: (name, d) => [`${name} continua offline`, `Offline há ${d}`],
    stillMany: (n, names, d) => [`${n} workers continuam offline`, `${names}\nMaior tempo offline: ${d}`],
  },
  fr: {
    units: ["min", "h", "j"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "sans nom",
    one: (name, d) => [`${name} hors ligne`, `Hors ligne depuis ${d}`],
    many: (n, names, d) => [`${n} workers hors ligne`, `${names}\nLe plus long : ${d}`],
    back: (name, d) => [`${name} de retour en ligne`, `Hors ligne pendant ${d}`],
    backMany: (n, names, d) => [`${n} workers de retour en ligne`, `${names}\nCoupure la plus longue : ${d}`],
    still: (name, d) => [`${name} toujours hors ligne`, `Hors ligne depuis ${d}`],
    stillMany: (n, names, d) => [`${n} workers toujours hors ligne`, `${names}\nLe plus long : ${d}`],
  },
  de: {
    units: ["Min.", "Std.", "Tg."], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "unbenannt",
    one: (name, d) => [`${name} offline`, `Seit ${d} offline`],
    many: (n, names, d) => [`${n} Worker offline`, `${names}\nAm längsten: ${d}`],
    back: (name, d) => [`${name} wieder online`, `War ${d} offline`],
    backMany: (n, names, d) => [`${n} Worker wieder online`, `${names}\nLängster Ausfall: ${d}`],
    still: (name, d) => [`${name} immer noch offline`, `Seit ${d} offline`],
    stillMany: (n, names, d) => [`${n} Worker immer noch offline`, `${names}\nAm längsten: ${d}`],
  },
  it: {
    units: ["min", "h", "gg"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "senza nome",
    one: (name, d) => [`${name} offline`, `Offline da ${d}`],
    many: (n, names, d) => [`${n} worker offline`, `${names}\nDurata massima: ${d}`],
    back: (name, d) => [`${name} di nuovo online`, `È rimasto offline per ${d}`],
    backMany: (n, names, d) => [`${n} worker di nuovo online`, `${names}\nInterruzione più lunga: ${d}`],
    still: (name, d) => [`${name} ancora offline`, `Offline da ${d}`],
    stillMany: (n, names, d) => [`${n} worker ancora offline`, `${names}\nDurata massima: ${d}`],
  },
  tr: {
    units: ["dk", "sa", "g"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "adsız",
    one: (name, d) => [`${name} çevrimdışı`, `Çevrimdışı süresi: ${d}`],
    many: (n, names, d) => [`${n} worker çevrimdışı`, `${names}\nEn uzun: ${d}`],
    back: (name, d) => [`${name} yeniden çevrimiçi`, `Çevrimdışı kaldığı süre: ${d}`],
    backMany: (n, names, d) => [`${n} worker yeniden çevrimiçi`, `${names}\nEn uzun kesinti: ${d}`],
    still: (name, d) => [`${name} hâlâ çevrimdışı`, `Çevrimdışı süresi: ${d}`],
    stillMany: (n, names, d) => [`${n} worker hâlâ çevrimdışı`, `${names}\nEn uzun: ${d}`],
  },
  ja: {
    units: ["分", "時間", "日"], gap: "", join: "", sep: "、", more: (_n, rest) => ` ほか${rest}台`, anon: "名前なし",
    one: (name, d) => [`${name}がオフライン`, `${d}間オフラインです`],
    many: (n, names, d) => [`ワーカー${n}台がオフライン`, `${names}\n最長：${d}`],
    back: (name, d) => [`${name}がオンラインに復帰`, `${d}間オフラインでした`],
    backMany: (n, names, d) => [`ワーカー${n}台がオンラインに復帰`, `${names}\n最長オフライン：${d}`],
    still: (name, d) => [`${name}はまだオフライン`, `${d}間オフラインです`],
    stillMany: (n, names, d) => [`ワーカー${n}台がまだオフライン`, `${names}\n最長：${d}`],
  },
  ko: {
    units: ["분", "시간", "일"], gap: "", sep: ", ", more: (_n, rest) => ` 외 ${rest}개`, anon: "이름 없음",
    one: (name, d) => [`${name} 오프라인`, `${d}째 오프라인`],
    many: (n, names, d) => [`워커 ${n}개 오프라인`, `${names}\n최장: ${d}`],
    back: (name, d) => [`${name} 다시 온라인`, `${d} 동안 오프라인이었습니다`],
    backMany: (n, names, d) => [`워커 ${n}개 다시 온라인`, `${names}\n최장 오프라인: ${d}`],
    still: (name, d) => [`${name} 아직 오프라인`, `${d}째 오프라인`],
    stillMany: (n, names, d) => [`워커 ${n}개 아직 오프라인`, `${names}\n최장: ${d}`],
  },
  hi: {
    units: ["मिनट", "घंटे", "दिन"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "बेनाम",
    one: (name, d) => [`${name} ऑफ़लाइन`, `${d} से ऑफ़लाइन`],
    many: (n, names, d) => [`${n} वर्कर ऑफ़लाइन`, `${names}\nसबसे ज़्यादा: ${d} से`],
    back: (name, d) => [`${name} फिर ऑनलाइन`, `${d} तक ऑफ़लाइन रहा`],
    backMany: (n, names, d) => [`${n} वर्कर फिर ऑनलाइन`, `${names}\nसबसे लंबा आउटेज: ${d} का`],
    still: (name, d) => [`${name} अब भी ऑफ़लाइन`, `${d} से ऑफ़लाइन`],
    stillMany: (n, names, d) => [`${n} वर्कर अब भी ऑफ़लाइन`, `${names}\nसबसे ज़्यादा: ${d} से`],
  },
  th: {
    units: ["นาที", "ชม.", "วัน"], sep: ", ", more: (_n, rest) => ` +${rest}`, anon: "ไม่มีชื่อ",
    one: (name, d) => [`${name} ออฟไลน์`, `ออฟไลน์มาแล้ว ${d}`],
    many: (n, names, d) => [`เวิร์กเกอร์ออฟไลน์ ${n} เครื่อง`, `${names}\nนานที่สุด: ${d}`],
    back: (name, d) => [`${name} กลับมาออนไลน์`, `ออฟไลน์ไป ${d}`],
    backMany: (n, names, d) => [`เวิร์กเกอร์กลับมาออนไลน์ ${n} เครื่อง`, `${names}\nออฟไลน์นานที่สุด: ${d}`],
    still: (name, d) => [`${name} ยังออฟไลน์อยู่`, `ออฟไลน์มาแล้ว ${d}`],
    stillMany: (n, names, d) => [`เวิร์กเกอร์ยังออฟไลน์ ${n} เครื่อง`, `${names}\nนานที่สุด: ${d}`],
  },
};

/// "12 min", "1 h 5 min", "3 d" — or "12분", "1시간 5분", "1時間5分" where the language
/// writes a unit against its number (`gap`) or the hours against the minutes (`join`).
export function fmtAgo(lang, seconds) {
  const w = W[lang] || W.en;
  const [min, h, d] = w.units;
  const of = (n, unit) => `${n}${w.gap ?? " "}${unit}`;
  const m = Math.max(1, Math.floor(seconds / 60));
  if (m < 60) return of(m, min);
  if (m >= 2 * 1440) return of(Math.floor(m / 1440), d);
  return of(Math.floor(m / 60), h) + (m % 60 ? (w.join ?? " ") + of(m % 60, min) : "");
}

const NAMES_SHOWN = 3;

/// The dot a title opens with: what happened reads at a glance, and still does when a
/// long worker name pushes the words after it off the line.
const DOWN = "🔴";
const UP = "🟢";

/// { title, subtitle, body } about workers on one monitor, from the copy `one` (a
/// single worker) or `many`. list: [{ name }] (at least one); seconds: the outage, the
/// longest of them.
function about(lang, watch, list, seconds, dot, one, many) {
  const w = W[lang] || W.en;
  const d = fmtAgo(lang, seconds);
  const short = (s) => {
    if (s.startsWith(ANON)) s = w.anon + s.slice(ANON.length);
    return s.length > 32 ? s.slice(0, 31) + "…" : s;
  };
  const names = list.slice(0, NAMES_SHOWN).map((x) => short(x.name)).join(w.sep)
    + (list.length > NAMES_SHOWN ? w.more(list.length, list.length - NAMES_SHOWN) : "");
  const [title, body] = list.length === 1 ? w[one](names, d) : w[many](list.length, names, d);
  return { title: `${dot} ${title}`, subtitle: watch.label || watch.pool, body };
}

/// Build the APNs payload for workers that went offline on one monitor.
/// watch: { id, pool, label }; down: [{ name, since }] (at least one); t: now.
export function offlinePayloadFor(lang, watch, down, t) {
  const alert = about(lang, watch, down, t - Math.min(...down.map((x) => x.since)), DOWN, "one", "many");
  return {
    aps: { alert, sound: "default", "thread-id": "worker-offline" },
    // Lets the app route a tap to the monitor.
    watch: { id: watch.id, n: down.length },
  };
}

/// …and for the ones that are back online, in the same thread as the push that said
/// they were offline. back: [{ name, since, at }] (at least one) — offline from, until.
export function onlinePayloadFor(lang, watch, back) {
  const alert = about(lang, watch, back, Math.max(...back.map((x) => x.at - x.since)), UP, "back", "backMany");
  return {
    aps: { alert, sound: "default", "thread-id": "worker-offline" },
    watch: { id: watch.id, n: back.length, back: true },
  };
}

/// …and the one reminder, for workers still offline some time after that push.
/// still: [{ name, since }] (at least one); t: now.
export function stillPayloadFor(lang, watch, still, t) {
  const alert = about(lang, watch, still, t - Math.min(...still.map((x) => x.since)), DOWN, "still", "stillMany");
  return {
    aps: { alert, sound: "default", "thread-id": "worker-offline" },
    watch: { id: watch.id, n: still.length, still: true },
  };
}

function wrap(title, body, rule, usd) {
  return {
    aps: { alert: { title, body }, sound: "default", "thread-id": "price-alert" },
    // Lets the app route a tap to the price screen / highlight the rule.
    alert: rule ? { id: rule.id, kind: rule.kind, usd } : { test: true, usd },
  };
}
