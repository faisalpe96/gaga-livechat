import { PlayerEmotion } from '../types.js';

export interface EmotionDetectionResult {
  emotion: PlayerEmotion;
  isFrustrated: boolean;
  matchedCues: string[];
}

const FRUSTRATION_KEYWORDS: Record<string, string[]> = {
  'id-ID': [
    'kesal', 'kesel', 'kecewa', 'parah', 'rugi', 'lama banget', 'lambat banget',
    'lelet', 'penipu', 'kapok', 'gimana sih', 'gimana dong', 'payah', 'bego',
    'anjing', 'bangsat', 'babi', 'tolol', 'marah', 'emosi', 'rugi dong',
    'gak bener', 'tidak bener', 'tidak becus', 'gak becus', 'kecewa berat',
    'capek', 'nyesel', 'curang', 'woi', 'woyy', 'woy', 'bohong', 'gak jelas',
    'ga jelas', 'buang-buang uang', 'buang duit', 'kembalikan uang', 'brengsek',
    'sudah bayar tapi belum masuk', 'udah bayar belum masuk juga'
  ],
  'th-TH': [
    'โมโห', 'หงุดหงิด', 'แย่มาก', 'ช้ามาก', 'โกง', 'เสียดายเงิน', 'ผิดหวัง',
    'หลอกลวง', 'แย่จริงๆ', 'ทำไมช้าจัง', 'บริการแย่'
  ],
  'vi-VN': [
    'bực mình', 'tức giận', 'quá tệ', 'lừa đảo', 'chậm quá', 'thất vọng',
    'tệ hại', 'mất tiền oan', 'làm ăn như vậy'
  ],
  'fil-PH': [
    'galit', 'nakakainis', 'scam', 'ang bagal', 'sayang pera', 'loko-loko',
    'bwisit', 'walang kwenta', 'sobrang tagal', 'panloloko'
  ],
  'ms-MY': [
    'kecewa', 'marah', 'penipu', 'lambat sangat', 'teruk', 'rugi', 'lelet',
    'tak masuk lagi', 'buang duit'
  ],
  'en': [
    'frustrated', 'angry', 'annoyed', 'terrible', 'awful', 'waste of money',
    'scam', 'scammer', 'cheat', 'horrible', 'unacceptable', 'ridiculous',
    'pissed', 'furious', 'taking so long', 'bad service', 'rip off'
  ],
};

const EMPATHY_PREFIXES: Record<string, string> = {
  'id-ID': 'Paham banget kak, pasti kesal dan tidak nyaman kalau ada kendala seperti ini. Tenang ya kak, kami bantu cek sampai tuntas.',
  'th-TH': 'เข้าใจความรู้สึกเลยค่ะ ต้องขออภัยในความไม่สะดวกเป็นอย่างยิ่งนะคะ ทางเราจะรีบช่วยดูแลและตรวจสอบให้โดยเร็วค่ะ',
  'vi-VN': 'Tôi rất hiểu sự khó chịu của anh/chị và thành thật xin lỗi vì sự bất tiện này. Chúng tôi sẽ hỗ trợ kiểm tra ngay lập tức.',
  'fil-PH': 'Naiintindihan po namin ang inyong pagkadismaya at humihingi po kami ng pasensya sa abala. Nandito po kami upang tumulong.',
  'ms-MY': 'Kami faham sangat rasa kesal anda dan memohon maaf atas kesulitan ini. Kami akan bantu semak sampai selesai.',
  'en': 'I completely understand your frustration and apologize for the inconvenience. Rest assured, I am here to help resolve this for you.',
};

export class EmotionDetector {
  /**
   * Deteksi emosi kesal / frustrasi pemain dari teks pesan.
   */
  detect(text: string, locale = 'id-ID'): EmotionDetectionResult {
    if (!text) {
      return { emotion: 'neutral', isFrustrated: false, matchedCues: [] };
    }

    const cleaned = text.toLowerCase().trim();
    const matchedCues: string[] = [];

    // 1. Cek frasa kekesalan spesifik per locale + fallback en
    const localeKeywords = FRUSTRATION_KEYWORDS[locale] || FRUSTRATION_KEYWORDS['id-ID'];
    for (const kw of localeKeywords) {
      if (cleaned.includes(kw)) {
        matchedCues.push(kw);
      }
    }

    // Juga periksa kata kunci umum bahasa Inggris jika bukan en
    if (locale !== 'en') {
      for (const kw of FRUSTRATION_KEYWORDS.en) {
        if (cleaned.includes(kw)) {
          matchedCues.push(kw);
        }
      }
    }

    // 2. Tanda baca agresif (misalnya "!!" atau "??!" atau "!!!")
    if (/!{2,}/.test(text) || /!\?+|\?!+/.test(text)) {
      matchedCues.push('aggressive_punctuation');
    }

    // 3. Huruf kapital penuh (All Caps shouting), minimal 3 kata dan 12 karakter
    const words = text.split(/\s+/).filter(Boolean);
    if (
      words.length >= 3 &&
      text.length >= 12 &&
      text === text.toUpperCase() &&
      /[A-Z]/.test(text)
    ) {
      matchedCues.push('all_caps_shouting');
    }

    const isFrustrated = matchedCues.length > 0;
    return {
      emotion: isFrustrated ? 'frustrated' : 'neutral',
      isFrustrated,
      matchedCues,
    };
  }

  /**
   * Ambil kalimat empati pembuka sesuai locale.
   */
  getEmpathyPrefix(locale = 'id-ID'): string {
    return EMPATHY_PREFIXES[locale] || EMPATHY_PREFIXES['en'];
  }

  /**
   * Sematkan kalimat empati di awal balasan jika emosi kesal terdeteksi.
   */
  wrapWithEmpathy(replyText: string, locale = 'id-ID', isFrustrated = false): string {
    if (!isFrustrated) return replyText;

    const prefix = this.getEmpathyPrefix(locale);
    // Hindari duplikasi jika sudah diawali kalimat empati
    if (
      replyText.includes(prefix) ||
      replyText.toLowerCase().includes('paham banget') ||
      replyText.toLowerCase().includes('understand your frustration')
    ) {
      return replyText;
    }

    return `${prefix} ${replyText}`;
  }
}
