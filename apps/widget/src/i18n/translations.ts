import { SupportedLocale } from '../types.js';

export interface UIStrings {
  title: string;
  statusOnline: string;
  statusConnecting: string;
  statusOffline: string;
  inputPlaceholder: string;
  sendButton: string;
  translatedBadge: string;
  selectLanguage: string;
  sessionClosed: string;
  liveChatChip: string;
  quickReplyLiveChat: string;
  categoryAccount: string;
  categoryPayment: string;
  categoryTechnical: string;
  categoryGameplay: string;
  categoryFeedback: string;
  attachTooltip: string;
  attachEvidenceHint: string;
}

export const TRANSLATIONS: Record<SupportedLocale, UIStrings> = {
  'id-ID': {
    title: 'Gaga Live Chat',
    statusOnline: 'Aktif',
    statusConnecting: 'Menghubungkan...',
    statusOffline: 'Koneksi terputus',
    inputPlaceholder: 'Ketik pesan Anda di sini...',
    sendButton: 'Kirim',
    translatedBadge: 'Diterjemahkan otomatis',
    selectLanguage: 'Pilih Bahasa',
    sessionClosed: 'Sesi percakapan telah ditutup.',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'Akun & Login',
    categoryPayment: 'Pembayaran & Top-up',
    categoryTechnical: 'Teknis',
    categoryGameplay: 'Gameplay & Item',
    categoryFeedback: 'Feedback & Lainnya',
    attachTooltip: 'Lampirkan file / foto bukti (📎)',
    attachEvidenceHint: 'Tips: Gunakan tombol klip kertas (📎) untuk melampirkan foto/screenshot bukti transaksi.',
  },
  'th-TH': {
    title: 'Gaga Live Chat',
    statusOnline: 'ออนไลน์',
    statusConnecting: 'กำลังเชื่อมต่อ...',
    statusOffline: 'การเชื่อมต่อขาดหาย',
    inputPlaceholder: 'พิมพ์ข้อความของคุณที่นี่...',
    sendButton: 'ส่ง',
    translatedBadge: 'แปลโดยอัตโนมัติ',
    selectLanguage: 'เลือกภาษา',
    sessionClosed: 'การสนทนาสิ้นสุดลงแล้ว',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'บัญชีและเข้าสู่ระบบ',
    categoryPayment: 'การชำระเงินและเติมเงิน',
    categoryTechnical: 'ปัญหาทางเทคนิค',
    categoryGameplay: 'การเล่นและไอเทม',
    categoryFeedback: 'ข้อเสนอแนะและอื่นๆ',
    attachTooltip: 'แนบไฟล์ / รูปหลักฐาน (📎)',
    attachEvidenceHint: 'คำแนะนำ: ใช้ปุ่มคลิปหนีบกระดาษ (📎) เพื่อแนบภาพหน้าจอหรือหลักฐานการชำระเงิน',
  },
  'fil-PH': {
    title: 'Gaga Live Chat',
    statusOnline: 'Online po',
    statusConnecting: 'Kumokonekta...',
    statusOffline: 'Nawalan ng koneksyon',
    inputPlaceholder: 'I-type po ang mensahe dito...',
    sendButton: 'Ipadala',
    translatedBadge: 'Awtomatikong isinalin',
    selectLanguage: 'Pumili ng Wika',
    sessionClosed: 'Sarado na po ang pag-uusap.',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'Account at Pag-login',
    categoryPayment: 'Pagbabayad at Top-up',
    categoryTechnical: 'Teknikal',
    categoryGameplay: 'Gameplay at Item',
    categoryFeedback: 'Puna at Iba pa',
    attachTooltip: 'Maglakip ng file / patunay na larawan (📎)',
    attachEvidenceHint: 'Tip: Gamitin ang paperclip button (📎) para maglakip ng screenshot o resibo.',
  },
  'ms-MY': {
    title: 'Gaga Live Chat',
    statusOnline: 'Dalam Talian',
    statusConnecting: 'Menyambung...',
    statusOffline: 'Terputus talian',
    inputPlaceholder: 'Taip mesej anda di sini...',
    sendButton: 'Hantar',
    translatedBadge: 'Diterjemah secara automatik',
    selectLanguage: 'Pilih Bahasa',
    sessionClosed: 'Sesi perbualan telah ditamatkan.',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'Akaun & Log Masuk',
    categoryPayment: 'Pembayaran & Tambah Nilai',
    categoryTechnical: 'Teknikal',
    categoryGameplay: 'Permainan & Item',
    categoryFeedback: 'Maklum Balas & Lain-lain',
    attachTooltip: 'Lampirkan fail / gambar bukti (📎)',
    attachEvidenceHint: 'Tip: Gunakan butang klip kertas (📎) untuk melampirkan tangkapan skrin atau resit transaksi.',
  },
  'vi-VN': {
    title: 'Gaga Live Chat',
    statusOnline: 'Trực tuyến',
    statusConnecting: 'Đang kết nối...',
    statusOffline: 'Mất kết nối',
    inputPlaceholder: 'Nhập tin nhắn của bạn tại đây...',
    sendButton: 'Gửi',
    translatedBadge: 'Dịch tự động',
    selectLanguage: 'Chọn ngôn ngữ',
    sessionClosed: 'Phiên trò chuyện đã kết thúc.',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'Tài khoản & Đăng nhập',
    categoryPayment: 'Thanh toán & Nạp tiền',
    categoryTechnical: 'Kỹ thuật',
    categoryGameplay: 'Lối chơi & Vật phẩm',
    categoryFeedback: 'Góp ý & Khác',
    attachTooltip: 'Đính kèm tệp / ảnh bằng chứng (📎)',
    attachEvidenceHint: 'Mẹo: Sử dụng nút kẹp giấy (📎) để đính kèm ảnh chụp màn hình hoặc biên lai.',
  },
  'en': {
    title: 'Gaga Live Chat',
    statusOnline: 'Online',
    statusConnecting: 'Connecting...',
    statusOffline: 'Disconnected',
    inputPlaceholder: 'Type your message here...',
    sendButton: 'Send',
    translatedBadge: 'Auto-translated',
    selectLanguage: 'Select Language',
    sessionClosed: 'This chat session has ended.',
    liveChatChip: 'Live Chat',
    quickReplyLiveChat: 'Live Chat',
    categoryAccount: 'Account & Login',
    categoryPayment: 'Payment & Top-up',
    categoryTechnical: 'Technical',
    categoryGameplay: 'Gameplay & Items',
    categoryFeedback: 'Feedback & Others',
    attachTooltip: 'Attach file / proof screenshot (📎)',
    attachEvidenceHint: 'Tip: Use the paperclip button (📎) to attach your screenshot or payment receipt.',
  },
};

export function getTranslations(locale: string): UIStrings {
  const norm = (locale || 'en') as SupportedLocale;
  return TRANSLATIONS[norm] || TRANSLATIONS['en'];
}
