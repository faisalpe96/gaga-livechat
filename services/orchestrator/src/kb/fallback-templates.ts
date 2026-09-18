/**
 * Kumpulan template tanggapan manusiawi saat tidak ada dokumen KB yang cocok (No-Doc Fallback).
 *
 * Aturan Mutlak:
 * 1. Bot TIDAK BOLEH diam (silent failure) atau langsung error.
 * 2. Bot TIDAK BOLEH memaksakan dokumen yang tidak relevan.
 * 3. Bot menanggapi secara ramah dan manusiawi: mengakui keluhan, menanyakan detail tambahan,
 *    atau menawarkan opsi untuk diteruskan langsung ke tim customer service / agen manusia.
 */

export interface FallbackTemplateGroup {
  standard: string[];
  frustrated: string[];
}

export const NO_DOC_FALLBACK_TEMPLATES: Record<string, FallbackTemplateGroup> = {
  'id-ID': {
    standard: [
      'Mohon maaf kak, kami belum menemukan panduan khusus terkait kendala tersebut. Boleh ceritakan lebih detail apa yang terjadi, atau mau kami teruskan ke tim customer service agar dibantu langsung?',
      'Kami belum menemukan rujukan yang tepat untuk kendala ini kak. Boleh dibantu jelaskan kronologinya, atau kakak ingin langsung dihubungkan dengan agen CS kami?',
    ],
    frustrated: [
      'Paham banget kak, kami mohon maaf atas ketidaknyamanannya. Saat ini kami belum menemukan panduan khusus untuk kendala kakak di sistem kami. Boleh ceritakan sedikit detailnya, atau kakak ingin langsung kami hubungkan dengan tim agen customer service?',
    ],
  },
  'th-TH': {
    standard: [
      'ขออภัยด้วยนะคะ ขณะนี้ทางเรายังไม่พบคู่มือที่ตรงกับปัญหาที่คุณแจ้ง สามารถแจ้งรายละเอียดปัญหาเพิ่มเติม หรือต้องการให้ทางเราประสานงานส่งต่อให้ทีมงานดูแลโดยตรงไหมคะ',
      'ขออภัยค่ะ ทางเรายังไม่พบข้อมูลที่ตรงกับเรื่องนี้ สามารถระบุรายละเอียดเพิ่มเติมได้เลยค่ะ หรือจะให้ส่งต่อเรื่องให้ทีมงานฝ่ายบริการลูกค้าทันทีดีคะ',
    ],
    frustrated: [
      'เข้าใจความรู้สึกเลยค่ะ ต้องขออภัยในความไม่สะดวกเป็นอย่างยิ่งนะคะ ขณะนี้ยังไม่พบคู่มือที่ตรงกับปัญหานี้ คุณลูกค้าต้องการแจ้งรายละเอียดเพิ่มเติม หรือต้องการให้ส่งต่อเจ้าหน้าที่ฝ่ายบริการลูกค้าทันทีคะ',
    ],
  },
  'vi-VN': {
    standard: [
      'Thành thật xin lỗi anh/chị, hiện tại chúng tôi chưa tìm thấy tài liệu hướng dẫn cụ thể cho vấn đề này. Anh/chị có thể chia sẻ thêm chi tiết, hoặc để chúng tôi kết nối ngay với đội ngũ hỗ trợ khách hàng không ạ?',
    ],
    frustrated: [
      'Tôi rất hiểu sự khó chịu của anh/chị và thành thật xin lỗi vì sự bất tiện này. Hiện tại hệ thống chưa có tài liệu cho trường hợp này, anh/chị có muốn tôi chuyển tiếp trực tiếp đến nhân viên hỗ trợ ngay không ạ?',
    ],
  },
  'fil-PH': {
    standard: [
      'Paumanhin po, wala pa po kaming nahanap na gabay para sa ganitong uri ng usapin. Maaari po ba ninyong ibahagi ang karagdagang detalye, o nais po ba ninyong ipasa namin ito sa customer service team para maasikaso agad?',
    ],
    frustrated: [
      'Naiintindihan po namin ang inyong pagkadismaya at humihingi po kami ng pasensya. Wala pa po kaming eksaktong gabay dito, nais po ba ninyong ikonekta namin kayo agad sa aming customer service representative?',
    ],
  },
  'ms-MY': {
    standard: [
      'Mohon maaf sangat, kami belum menemui panduan khusus berkaitan isu yang dinyatakan. Boleh kongsikan butiran lanjut mengenai masalah tersebut, atau mahu kami panjangkan kepada pasukan perkhidmatan pelanggan untuk bantuan langsung?',
    ],
    frustrated: [
      'Kami faham sangat rasa kesal anda dan memohon maaf atas kesulitan ini. Kami belum menjumpai panduan berkenaan isu ini, adakah anda mahu kami sambungkan terus kepada wakil khidmat pelanggan kami?',
    ],
  },
  'en': {
    standard: [
      'I apologize, but I could not find specific documentation regarding this issue. Could you share more details about what happened, or would you prefer me to transfer you to our support team for direct assistance?',
      'I am sorry, but I do not have reference guides for this specific inquiry yet. Would you like to provide more details, or should I forward this conversation to a customer service representative?',
    ],
    frustrated: [
      'I completely understand your frustration and apologize for the inconvenience. I do not have a direct guide for this in our system yet. Would you like to share a few more details, or should I transfer you immediately to our support team?',
    ],
  },
};

/**
 * Dapatkan template tanggapan saat tidak ada dokumen KB yang cocok.
 */
export function getNoDocFallbackResponse(locale = 'id-ID', isFrustrated = false): string {
  const group = NO_DOC_FALLBACK_TEMPLATES[locale] || NO_DOC_FALLBACK_TEMPLATES['id-ID'];
  const pool = isFrustrated && group.frustrated.length > 0 ? group.frustrated : group.standard;
  return pool[0];
}
