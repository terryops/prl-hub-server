// Transactional mail uses inline table styles so its essentials survive email
// clients that strip stylesheets, block images or ignore rounded corners.
const copy = {
  en: {
    tag: "ACCOUNT VERIFICATION", titles: ["Your sign-in code", "Confirm account deletion", "Verify your current email", "Verify your new email", "Link your purchase"],
    intro: "Enter this code in Pearl Hub to continue.", label: "Verification code", expires: "Valid for 5 minutes", latest: "If you requested another code, use the latest email.",
    private: "Keep this code to yourself.", ignore: "If you didn’t request this, you can safely ignore this email.",
  },
  "zh-Hans": {
    tag: "邮箱验证", titles: ["你的登录验证码", "确认注销账号", "验证当前邮箱", "验证新邮箱", "关联购买权益"],
    intro: "请在 Pearl Hub 中输入以下验证码，继续完成操作。", label: "验证码", expires: "5 分钟内有效", latest: "如已重新获取验证码，请使用最新邮件中的验证码。",
    private: "请勿向他人分享验证码。", ignore: "如果不是你发起的操作，忽略这封邮件即可。",
  },
  "zh-Hant": {
    tag: "電子郵件驗證", titles: ["你的登入驗證碼", "確認刪除帳號", "驗證目前電子郵件", "驗證新電子郵件", "關聯購買權益"],
    intro: "請在 Pearl Hub 中輸入以下驗證碼，繼續完成操作。", label: "驗證碼", expires: "5 分鐘內有效", latest: "若已重新取得驗證碼，請使用最新郵件中的驗證碼。",
    private: "請勿向他人分享驗證碼。", ignore: "如果不是你發起的操作，忽略這封郵件即可。",
  },
  ru: {
    tag: "ПОДТВЕРЖДЕНИЕ АККАУНТА", titles: ["Ваш код для входа", "Подтвердите удаление аккаунта", "Подтвердите текущую почту", "Подтвердите новую почту", "Привяжите покупку"],
    intro: "Введите этот код в Pearl Hub, чтобы продолжить.", label: "Код подтверждения", expires: "Действует 5 минут", latest: "Если вы запросили новый код, используйте последнее письмо.",
    private: "Никому не сообщайте этот код.", ignore: "Если вы не запрашивали код, просто проигнорируйте письмо.",
  },
  vi: {
    tag: "XÁC MINH TÀI KHOẢN", titles: ["Mã đăng nhập của bạn", "Xác nhận xóa tài khoản", "Xác minh email hiện tại", "Xác minh email mới", "Liên kết giao dịch mua"],
    intro: "Nhập mã này trong Pearl Hub để tiếp tục.", label: "Mã xác minh", expires: "Có hiệu lực trong 5 phút", latest: "Nếu đã yêu cầu mã mới, hãy dùng mã trong email mới nhất.",
    private: "Không chia sẻ mã này với người khác.", ignore: "Nếu bạn không yêu cầu mã, hãy bỏ qua email này.",
  },
  id: {
    tag: "VERIFIKASI AKUN", titles: ["Kode masuk Anda", "Konfirmasi penghapusan akun", "Verifikasi email saat ini", "Verifikasi email baru", "Tautkan pembelian"],
    intro: "Masukkan kode ini di Pearl Hub untuk melanjutkan.", label: "Kode verifikasi", expires: "Berlaku selama 5 menit", latest: "Jika meminta kode baru, gunakan email terbaru.",
    private: "Jangan bagikan kode ini kepada siapa pun.", ignore: "Jika Anda tidak meminta kode, abaikan email ini.",
  },
  es: {
    tag: "VERIFICACIÓN DE CUENTA", titles: ["Tu código de acceso", "Confirma la eliminación de la cuenta", "Verifica tu correo actual", "Verifica tu nuevo correo", "Vincula tu compra"],
    intro: "Introduce este código en Pearl Hub para continuar.", label: "Código de verificación", expires: "Válido durante 5 minutos", latest: "Si has solicitado otro código, utiliza el correo más reciente.",
    private: "No compartas este código con nadie.", ignore: "Si no has solicitado el código, puedes ignorar este correo.",
  },
  "pt-BR": {
    tag: "VERIFICAÇÃO DA CONTA", titles: ["Seu código de acesso", "Confirme a exclusão da conta", "Verifique seu e-mail atual", "Verifique seu novo e-mail", "Vincule sua compra"],
    intro: "Digite este código no Pearl Hub para continuar.", label: "Código de verificação", expires: "Válido por 5 minutos", latest: "Se solicitou outro código, use o e-mail mais recente.",
    private: "Não compartilhe este código com ninguém.", ignore: "Se não solicitou o código, pode ignorar este e-mail.",
  },
  fr: {
    tag: "VÉRIFICATION DU COMPTE", titles: ["Votre code de connexion", "Confirmez la suppression du compte", "Vérifiez votre adresse actuelle", "Vérifiez votre nouvelle adresse", "Associez votre achat"],
    intro: "Saisissez ce code dans Pearl Hub pour continuer.", label: "Code de vérification", expires: "Valable pendant 5 minutes", latest: "Si vous avez demandé un autre code, utilisez le dernier e-mail.",
    private: "Ne partagez ce code avec personne.", ignore: "Si vous n’avez pas demandé ce code, ignorez cet e-mail.",
  },
  de: {
    tag: "KONTOVERIFIZIERUNG", titles: ["Dein Anmeldecode", "Kontolöschung bestätigen", "Aktuelle E-Mail bestätigen", "Neue E-Mail bestätigen", "Kauf verknüpfen"],
    intro: "Gib diesen Code in Pearl Hub ein, um fortzufahren.", label: "Verifizierungscode", expires: "5 Minuten gültig", latest: "Wenn du einen neuen Code angefordert hast, verwende die neueste E-Mail.",
    private: "Teile diesen Code mit niemandem.", ignore: "Wenn du diesen Code nicht angefordert hast, ignoriere diese E-Mail.",
  },
  it: {
    tag: "VERIFICA DELL’ACCOUNT", titles: ["Il tuo codice di accesso", "Conferma l’eliminazione dell’account", "Verifica l’email attuale", "Verifica la nuova email", "Collega il tuo acquisto"],
    intro: "Inserisci questo codice in Pearl Hub per continuare.", label: "Codice di verifica", expires: "Valido per 5 minuti", latest: "Se hai richiesto un altro codice, usa l’email più recente.",
    private: "Non condividere questo codice con nessuno.", ignore: "Se non hai richiesto il codice, puoi ignorare questa email.",
  },
  tr: {
    tag: "HESAP DOĞRULAMA", titles: ["Giriş kodunuz", "Hesap silmeyi onaylayın", "Mevcut e-postanızı doğrulayın", "Yeni e-postanızı doğrulayın", "Satın alımınızı bağlayın"],
    intro: "Devam etmek için bu kodu Pearl Hub’a girin.", label: "Doğrulama kodu", expires: "5 dakika geçerli", latest: "Yeni bir kod istediyseniz en son e-postayı kullanın.",
    private: "Bu kodu kimseyle paylaşmayın.", ignore: "Bu kodu siz istemediyseniz e-postayı yok sayabilirsiniz.",
  },
  ja: {
    tag: "メール認証", titles: ["ログイン確認コード", "アカウントの削除を確認", "現在のメールアドレスを確認", "新しいメールアドレスを確認", "購入を連携"],
    intro: "Pearl Hubでこのコードを入力して、操作を続けてください。", label: "確認コード", expires: "5分間有効", latest: "コードを再取得した場合は、最新のメールを使用してください。",
    private: "このコードを他の人と共有しないでください。", ignore: "この操作に心当たりがない場合は、このメールを無視してください。",
  },
  ko: {
    tag: "이메일 인증", titles: ["로그인 인증 코드", "계정 삭제 확인", "현재 이메일 인증", "새 이메일 인증", "구매 연결"],
    intro: "Pearl Hub에서 이 코드를 입력해 계속 진행하세요.", label: "인증 코드", expires: "5분 동안 유효", latest: "코드를 다시 요청했다면 가장 최근 이메일의 코드를 사용하세요.",
    private: "이 코드를 다른 사람과 공유하지 마세요.", ignore: "직접 요청하지 않았다면 이 이메일을 무시하세요.",
  },
  hi: {
    tag: "ईमेल सत्यापन", titles: ["आपका साइन-इन कोड", "खाता हटाने की पुष्टि करें", "वर्तमान ईमेल सत्यापित करें", "नया ईमेल सत्यापित करें", "अपनी खरीद जोड़ें"],
    intro: "आगे बढ़ने के लिए Pearl Hub में यह कोड डालें।", label: "सत्यापन कोड", expires: "5 मिनट के लिए मान्य", latest: "यदि आपने नया कोड माँगा है, तो सबसे हाल का ईमेल इस्तेमाल करें।",
    private: "यह कोड किसी के साथ साझा न करें।", ignore: "यदि आपने यह कोड नहीं माँगा है, तो इस ईमेल को अनदेखा करें।",
  },
  th: {
    tag: "ยืนยันอีเมล", titles: ["รหัสเข้าสู่ระบบของคุณ", "ยืนยันการลบบัญชี", "ยืนยันอีเมลปัจจุบัน", "ยืนยันอีเมลใหม่", "เชื่อมโยงการซื้อ"],
    intro: "กรอกรหัสนี้ใน Pearl Hub เพื่อดำเนินการต่อ", label: "รหัสยืนยัน", expires: "ใช้ได้ภายใน 5 นาที", latest: "หากขอรหัสใหม่แล้ว ให้ใช้รหัสจากอีเมลล่าสุด",
    private: "อย่าแชร์รหัสนี้กับผู้อื่น", ignore: "หากคุณไม่ได้เป็นผู้ขอรหัส สามารถเพิกเฉยต่ออีเมลนี้ได้",
  },
};

export const EMAIL_LANGS = Object.keys(copy);
const purposes = ["login", "delete", "change_old", "change_new", "purchase"];

export function verificationEmail({ code, purpose = "login", lang = "en" }) {
  if (!/^\d{6}$/.test(code) || typeof code !== "string") throw new Error("invalid_email_code");
  const index = purposes.indexOf(purpose);
  if (index < 0) throw new Error("invalid_email_purpose");
  const language = typeof lang === "string" && Object.hasOwn(copy, lang) ? lang
    : typeof lang === "string" && /^zh/i.test(lang) ? (/hant|tw|hk/i.test(lang) ? "zh-Hant" : "zh-Hans") : "en";
  const c = copy[language], title = c.titles[index];
  const text = `Pearl Hub\n\n${title}\n${c.intro}\n\n${c.label}: ${code}\n${c.expires}\n${c.latest}\n\n${c.private}\n${c.ignore}\n\nhttps://pearlhub.net/`;
  const html = `<!doctype html>
<html lang="${language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>Pearl Hub</title>
<style>
@media (max-width:480px) { .email-outer { padding:24px 12px!important; } .email-body { padding:26px 24px!important; } .email-title { font-size:24px!important;line-height:34px!important; } .email-code { font-size:38px!important;letter-spacing:6px!important; } }
@media (prefers-color-scheme:dark) { .email-background { background-color:#171f31!important; } .email-card { background-color:#202b42!important;border-color:#35425c!important; } .email-title { color:#edf2ff!important; } .email-copy { color:#b2bfd5!important; } .email-brand,.email-tag { color:#a5baff!important; } .email-code-panel { background-color:#283956!important;border-color:#3b5077!important; } .email-code { color:#c3d2ff!important; } .email-rule { border-color:#35425c!important; } .email-link { color:#a5baff!important; } }
</style></head>
<body class="email-background" style="margin:0;padding:0;width:100%;background-color:#f4f6fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,'PingFang SC','Microsoft YaHei',sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${title} · ${c.expires}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-background" bgcolor="#f4f6fc" style="background-color:#f4f6fc;"><tr><td align="center" class="email-outer" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-card" bgcolor="#ffffff" style="max-width:520px;background-color:#ffffff;border:1px solid #e6eaf3;border-radius:18px;overflow:hidden;">
<tr><td height="5" bgcolor="#5478ed" style="height:5px;line-height:5px;font-size:1px;background-color:#5478ed;">&nbsp;</td></tr>
<tr><td class="email-body" style="padding:32px 28px;">
<p class="email-brand" style="margin:0 0 24px;color:#5478ed;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.5px;">Pearl Hub</p>
<p class="email-tag" style="margin:0 0 8px;color:#465cc4;font-size:11px;line-height:18px;font-weight:600;letter-spacing:1.3px;">${c.tag}</p>
<h1 class="email-title" style="margin:0 0 12px;color:#24314d;font-size:28px;line-height:38px;font-weight:700;">${title}</h1>
<p class="email-copy" style="margin:0 0 24px;color:#64728b;font-size:15px;line-height:25px;">${c.intro}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" class="email-code-panel" bgcolor="#f1f4ff" style="padding:22px 10px 20px;background-color:#f1f4ff;border:1px solid #dfe6ff;border-radius:12px;">
<p class="email-copy" style="margin:0 0 8px;color:#64728b;font-size:12px;line-height:18px;">${c.label}</p>
<p class="email-code" style="margin:0 0 8px;color:#2c4cc6;font-family:Consolas,'Courier New',monospace;font-size:42px;line-height:54px;font-weight:700;letter-spacing:7px;white-space:nowrap;">${code}</p>
<p class="email-copy" style="margin:0;color:#64728b;font-size:13px;line-height:20px;">${c.expires}</p>
</td></tr></table>
<p class="email-copy" style="margin:14px 0 24px;color:#64728b;font-size:12px;line-height:20px;">${c.latest}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="email-rule" style="border-top:1px solid #e6eaf3;padding-top:20px;">
<p class="email-copy" style="margin:0 0 6px;color:#64728b;font-size:13px;line-height:22px;font-weight:600;">${c.private}</p>
<p class="email-copy" style="margin:0;color:#64728b;font-size:13px;line-height:22px;">${c.ignore}</p>
</td></tr></table>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p class="email-copy" style="margin:20px 0 0;color:#64728b;font-size:12px;line-height:20px;">Pearl Hub&nbsp; · &nbsp;<a class="email-link" href="https://pearlhub.net/?account=manage" style="color:#465cc4;text-decoration:none;">pearlhub.net</a></p>
</td></tr></table>
</body></html>`;
  return { subject: `Pearl Hub · ${title}: ${code}`, text, html };
}
