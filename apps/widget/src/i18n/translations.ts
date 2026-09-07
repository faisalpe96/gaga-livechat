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
  },
};

export function getTranslations(locale: string): UIStrings {
  const norm = (locale || 'en') as SupportedLocale;
  return TRANSLATIONS[norm] || TRANSLATIONS['en'];
}
