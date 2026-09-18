/**
 * Category-Driven Investigation & Field Collection Service
 * Menyimpan dan mengelola field checklist investigasi berbasis database per kategori
 * Sesuai kebutuhan investigasi Akun & Login, Pembayaran, Teknis, Gameplay, dan Feedback.
 */

import pg from 'pg';

export interface CategoryFieldDefinition {
  id?: string;
  category: string;
  field_key: string;
  priority: number;
  is_required: boolean;
  validation_regex?: string | null;
  session_mapping?: string | null; // 'uid' | 'nickname' | 'server' | 'platform' | 'app_version' | 'device_model'
  evidence_type?: string | null;   // 'attachment' | 'text' | 'screenshot'
  labels: Record<string, string>;  // per-locale
  prompt_questions: Record<string, string>; // per-locale
}

export interface CollectedFieldStatus {
  key: string;
  label: string;
  is_required: boolean;
  status: 'collected' | 'pending';
  value?: string;
  evidence_type?: string | null;
}

export const SEED_CATEGORY_FIELDS: CategoryFieldDefinition[] = [
  // =========================================================================
  // 1. AKUN & LOGIN (account_login)
  // =========================================================================
  {
    category: 'account_login',
    field_key: 'nickname_or_uid',
    priority: 1,
    is_required: true,
    session_mapping: 'uid',
    labels: {
      'id-ID': 'Nickname atau UID',
      'th-TH': 'ชื่อเล่นหรือ UID',
      'fil-PH': 'Nickname o UID',
      'ms-MY': 'Nama Samaran atau UID',
      'vi-VN': 'Biệt danh hoặc UID',
      'en': 'Nickname or UID',
    },
    prompt_questions: {
      'id-ID': 'Bisa sebutkan Nickname atau UID akun yang sedang bermasalah?',
      'th-TH': 'รบกวนแจ้งชื่อเล่นหรือ UID ของบัญชีที่พบปัญหาได้ไหมคะ/ครับ?',
      'fil-PH': 'Maaari mo bang ibigay ang Nickname o UID ng account na may problema?',
      'ms-MY': 'Bolehkah anda berikan Nickname atau UID akaun yang bermasalah?',
      'vi-VN': 'Bạn có thể cung cấp Biệt danh hoặc UID của tài khoản gặp sự cố không?',
      'en': 'Could you share the Nickname or UID of the affected account?',
    },
  },
  {
    category: 'account_login',
    field_key: 'login_issue_desc',
    priority: 2,
    is_required: true,
    labels: {
      'id-ID': 'Gejala Masalah Login',
      'th-TH': 'อาการเมื่อเข้าสู่ระบบ',
      'fil-PH': 'Deskripsyon ng Problema sa Pag-log in',
      'ms-MY': 'Gejala Masalah Log Masuk',
      'vi-VN': 'Hiện tượng khi đăng nhập',
      'en': 'What Happens When Logging In',
    },
    prompt_questions: {
      'id-ID': 'Apa yang sebenarnya terjadi saat kamu mencoba login (misalnya layar putih, mental/crash, atau ada keterangan tertentu)?',
      'th-TH': 'เกิดอะไรขึ้นอย่างชัดเจนเมื่อพยายามเข้าสู่ระบบ (เช่น จอขาว เด้งออก หรือมีข้อความเตือน)?',
      'fil-PH': 'Ano po ang eksaktong nangyayari tuwing sumusubok mag-log in (hal. nag-crash, black screen, o may mensahe)?',
      'ms-MY': 'Apakah yang berlaku apabila anda cuba log masuk (contohnya tersekat, terkeluar, atau ada mesej ralat)?',
      'vi-VN': 'Chính xác điều gì xảy ra khi bạn đăng nhập (ví dụ bị văng game, màn hình trắng, hay thông báo lỗi)?',
      'en': 'What exactly happens when you try to log in (e.g. freeze, crash, or specific message)?',
    },
  },
  {
    category: 'account_login',
    field_key: 'last_login_time',
    priority: 3,
    is_required: true,
    labels: {
      'id-ID': 'Waktu Terakhir Berhasil Login',
      'th-TH': 'เวลาเข้าสู่ระบบสำเร็จล่าสุด',
      'fil-PH': 'Huling Matagumpay na Pag-login',
      'ms-MY': 'Masa Terakhir Berjaya Log Masuk',
      'vi-VN': 'Thời gian đăng nhập thành công gần nhất',
      'en': 'Last Successful Login Time',
    },
    prompt_questions: {
      'id-ID': 'Kapan terakhir kali kamu berhasil masuk ke dalam game?',
      'th-TH': 'เข้าสู่ระบบเกมสำเร็จครั้งล่าสุดเมื่อไรคะ/ครับ?',
      'fil-PH': 'Kailan po ang huling beses na matagumpay kayong nakapasok sa laro?',
      'ms-MY': 'Bilakah kali terakhir anda berjaya masuk ke dalam permainan?',
      'vi-VN': 'Lần gần nhất bạn đăng nhập thành công vào game là khi nào?',
      'en': 'When was the last time you successfully logged into the game?',
    },
  },
  {
    category: 'account_login',
    field_key: 'login_method',
    priority: 4,
    is_required: true,
    labels: {
      'id-ID': 'Metode Login',
      'th-TH': 'วิธีเข้าสู่ระบบ',
      'fil-PH': 'Paraan ng Pag-login',
      'ms-MY': 'Kaedah Log Masuk',
      'vi-VN': 'Phương thức đăng nhập',
      'en': 'Login Method',
    },
    prompt_questions: {
      'id-ID': 'Metode login apa yang kamu gunakan (Google, Apple, Gaga Passport, atau Guest)?',
      'th-TH': 'ใช้วิธีการเข้าสู่ระบบแบบใดคะ/ครับ (Google, Apple, Gaga Passport หรือ Guest)?',
      'fil-PH': 'Anong paraan ng pag-login ang gamit mo (Google, Apple, Gaga Passport, o Guest)?',
      'ms-MY': 'Kaedah log masuk manakah yang anda gunakan (Google, Apple, Gaga Passport, atau Guest)?',
      'vi-VN': 'Bạn sử dụng phương thức đăng nhập nào (Google, Apple, Gaga Passport, hay Guest)?',
      'en': 'Which login method do you use (Google, Apple, Gaga Passport, or Guest)?',
    },
  },
  {
    category: 'account_login',
    field_key: 'device_info',
    priority: 5,
    is_required: true,
    session_mapping: 'device_model',
    labels: {
      'id-ID': 'Perangkat & Status Ganti HP',
      'th-TH': 'อุปกรณ์และการเปลี่ยนอุปกรณ์',
      'fil-PH': 'Device at Pagpalit ng Device',
      'ms-MY': 'Peranti & Pertukaran Peranti',
      'vi-VN': 'Thiết bị & Đổi thiết bị',
      'en': 'Device and Recent Change',
    },
    prompt_questions: {
      'id-ID': 'Perangkat apa yang kamu gunakan dan apakah baru-baru ini ada pergantian HP/perangkat?',
      'th-TH': 'ใช้อุปกรณ์รุ่นใดเล่นเกม และเพิ่งมีการเปลี่ยนเครื่องใหม่เร็วๆ นี้ไหมคะ/ครับ?',
      'fil-PH': 'Anong device ang gamit mo at nagpalit ka ba ng device kamakailan?',
      'ms-MY': 'Peranti apakah yang anda gunakan dan adakah anda baru sahaja menukar peranti?',
      'vi-VN': 'Bạn đang dùng thiết bị gì và gần đây có đổi máy mới không?',
      'en': 'What device are you using, and did you recently switch devices?',
    },
  },
  {
    category: 'account_login',
    field_key: 'error_message',
    priority: 6,
    is_required: false,
    labels: {
      'id-ID': 'Pesan / Kode Error',
      'th-TH': 'ข้อความหรือรหัสข้อผิดพลาด',
      'fil-PH': 'Error Message o Code',
      'ms-MY': 'Mesej atau Kod Ralat',
      'vi-VN': 'Thông báo hoặc mã lỗi',
      'en': 'Error Message Shown',
    },
    prompt_questions: {
      'id-ID': 'Apakah ada pesan atau kode error tertentu yang muncul di layar?',
      'th-TH': 'มีข้อความหรือรหัส Error ใดๆ ปรากฏขึ้นบนหน้าจอไหมคะ/ครับ?',
      'fil-PH': 'May lumalabas po bang error code o mensahe sa screen?',
      'ms-MY': 'Adakah sebarang mesej atau kod ralat yang dipaparkan pada skrin?',
      'vi-VN': 'Có thông báo lỗi hoặc mã lỗi nào hiển thị trên màn hình không?',
      'en': 'Does any specific error message or code appear on screen?',
    },
  },

  // =========================================================================
  // 2. PEMBAYARAN & TOP-UP (payment_topup)
  // =========================================================================
  {
    category: 'payment_topup',
    field_key: 'order_id',
    priority: 1,
    is_required: true,
    evidence_type: 'attachment',
    labels: {
      'id-ID': 'Order ID / Bukti Transaksi',
      'th-TH': 'หมายเลขคำสั่งซื้อ / สลิปหลักฐาน',
      'fil-PH': 'Order ID o Resibo ng Transaksyon',
      'ms-MY': 'ID Pesanan / Bukti Pembayaran',
      'vi-VN': 'Mã đơn hàng / Bằng chứng giao dịch',
      'en': 'Order ID or Proof of Transaction',
    },
    prompt_questions: {
      'id-ID': 'Bisa sebutkan Order ID transaksi atau lampirkan struk bukti pembelian?',
      'th-TH': 'รบกวนแจ้งหมายเลข Order ID หรือส่งรูปสลิปหลักฐานการชำระเงินได้ไหมคะ/ครับ?',
      'fil-PH': 'Maaari mo bang ibigay ang Order ID o maglakip ng resibo ng transaksyon?',
      'ms-MY': 'Bolehkah anda berikan Order ID atau lampirkan resit bukti pembayaran?',
      'vi-VN': 'Bạn có thể gửi Mã đơn hàng (Order ID) hoặc hình ảnh hóa đơn thanh toán không?',
      'en': 'Could you share the Order ID or attach a screenshot/receipt of the transaction?',
    },
  },
  {
    category: 'payment_topup',
    field_key: 'amount',
    priority: 2,
    is_required: true,
    labels: {
      'id-ID': 'Nominal Pembelian',
      'th-TH': 'ยอดเงิน / จำนวนเพชร',
      'fil-PH': 'Halaga ng Transaksyon',
      'ms-MY': 'Jumlah Pembelian',
      'vi-VN': 'Số tiền / Kim cương nạp',
      'en': 'Transaction Amount',
    },
    prompt_questions: {
      'id-ID': 'Berapa nominal transaksi atau paket diamond yang kamu beli?',
      'th-TH': 'ยอดเงินหรือแพ็กเกจเพชรที่สั่งซื้อมีมูลค่าเท่าใดคะ/ครับ?',
      'fil-PH': 'Magkano po ang halaga ng biniling package o diamond?',
      'ms-MY': 'Berapakah jumlah transaksi atau pakej yang anda beli?',
      'vi-VN': 'Gói nạp hoặc số tiền bạn đã thanh toán là bao nhiêu?',
      'en': 'How much was the transaction amount or which package did you purchase?',
    },
  },
  {
    category: 'payment_topup',
    field_key: 'payment_method',
    priority: 3,
    is_required: true,
    labels: {
      'id-ID': 'Metode Pembayaran',
      'th-TH': 'ช่องทางชำระเงิน',
      'fil-PH': 'Paraan ng Pagbabayad',
      'ms-MY': 'Kaedah Pembayaran',
      'vi-VN': 'Phương thức thanh toán',
      'en': 'Payment Method',
    },
    prompt_questions: {
      'id-ID': 'Metode pembayaran apa yang kamu gunakan (misalnya QRIS, DANA, GoPay, Pulsa)?',
      'th-TH': 'ชำระเงินผ่านช่องทางใดคะ/ครับ (เช่น TrueMoney, PromptPay, บัตรเครดิต)?',
      'fil-PH': 'Anong paraan ng pagbabayad ang ginamit (hal. GCash, Maya, Load)?',
      'ms-MY': 'Apakah kaedah pembayaran yang digunakan (contohnya Touch n Go, GrabPay, FPX)?',
      'vi-VN': 'Bạn thanh toán qua hình thức nào (ví dụ Momo, ZaloPay, Thẻ ATM/Visa)?',
      'en': 'Which payment method did you use (e.g. e-wallet, bank transfer, credit card)?',
    },
  },
  {
    category: 'payment_topup',
    field_key: 'transaction_time',
    priority: 4,
    is_required: true,
    labels: {
      'id-ID': 'Waktu Transaksi',
      'th-TH': 'เวลาทำรายการ',
      'fil-PH': 'Oras ng Transaksyon',
      'ms-MY': 'Waktu Transaksi',
      'vi-VN': 'Thời gian giao dịch',
      'en': 'Transaction Time',
    },
    prompt_questions: {
      'id-ID': 'Kira-kira pada jam dan tanggal berapa transaksi tersebut dilakukan?',
      'th-TH': 'ทำรายการช่วงเวลาประมาณกี่โมงและวันที่เท่าไรคะ/ครับ?',
      'fil-PH': 'Kailan po humigit-kumulang ang oras at petsa ng transaksyon?',
      'ms-MY': 'Kira-kira pada pukul berapakah transaksi tersebut dilakukan?',
      'vi-VN': 'Giao dịch được thực hiện vào khoảng mấy giờ và ngày nào?',
      'en': 'Around what time and date was the transaction completed?',
    },
  },
  {
    category: 'payment_topup',
    field_key: 'balance_deducted',
    priority: 5,
    is_required: true,
    labels: {
      'id-ID': 'Status Pemotongan Saldo',
      'th-TH': 'สถานะการหักเงินในบัญชี',
      'fil-PH': 'Kaltas sa Balanse',
      'ms-MY': 'Status Tolakan Baki',
      'vi-VN': 'Tình trạng trừ tiền tài khoản',
      'en': 'Balance Deducted Status',
    },
    prompt_questions: {
      'id-ID': 'Apakah saldo di rekening atau e-wallet kamu sudah terpotong?',
      'th-TH': 'ยอดเงินในบัญชีหรือกระเป๋าเงินของคุณถูกหักไปเรียบร้อยแล้วใช่ไหมคะ/ครับ?',
      'fil-PH': 'Nababawasan na po ba ang balanse sa inyong bangko o e-wallet?',
      'ms-MY': 'Adakah baki dalam akaun bank atau e-dompet anda sudah ditolak?',
      'vi-VN': 'Số dư trong tài khoản ngân hàng hoặc ví điện tử của bạn đã bị trừ chưa?',
      'en': 'Has the balance been deducted from your bank account or e-wallet?',
    },
  },

  // =========================================================================
  // 3. TEKNIS (technical)
  // =========================================================================
  {
    category: 'technical',
    field_key: 'activity_when_happened',
    priority: 1,
    is_required: true,
    labels: {
      'id-ID': 'Aktivitas Saat Terjadi',
      'th-TH': 'กิจกรรมที่กำลังทำอยู่',
      'fil-PH': 'Ginagawa nang Mangyari',
      'ms-MY': 'Aktiviti Semasa Berlaku',
      'vi-VN': 'Thao tác khi xảy ra lỗi',
      'en': 'Activity When Occurred',
    },
    prompt_questions: {
      'id-ID': 'Apa yang sedang kamu lakukan di dalam game saat kendala tersebut muncul?',
      'th-TH': 'กำลังทำอะไรอยู่ในเกมเมื่อเกิดปัญหาขึ้นคะ/ครับ?',
      'fil-PH': 'Ano po ang ginagawa mo sa laro noong lumitaw ang problema?',
      'ms-MY': 'Apakah yang sedang anda lakukan di dalam permainan semasa masalah timbul?',
      'vi-VN': 'Bạn đang thao tác gì trong game khi sự cố xảy ra?',
      'en': 'What were you doing in the game when this issue occurred?',
    },
  },
  {
    category: 'technical',
    field_key: 'error_code_or_msg',
    priority: 2,
    is_required: false,
    labels: {
      'id-ID': 'Pesan / Kode Error',
      'th-TH': 'รหัสหรือข้อความ Error',
      'fil-PH': 'Error Code o Mensahe',
      'ms-MY': 'Mesej atau Kod Ralat',
      'vi-VN': 'Mã hoặc thông báo lỗi',
      'en': 'Error Code or Message',
    },
    prompt_questions: {
      'id-ID': 'Apakah ada kode atau pesan error tertentu yang ditampilkan di layar?',
      'th-TH': 'มีโค้ด Error หรือข้อความแจ้งเตือนแสดงขึ้นมาไหมคะ/ครับ?',
      'fil-PH': 'May error code po ba o mensahe na lumabas sa inyong screen?',
      'ms-MY': 'Adakah sebarang kod ralat atau mesej yang dipaparkan?',
      'vi-VN': 'Có mã lỗi hoặc dòng thông báo lỗi nào hiển thị không?',
      'en': 'Is there any specific error code or message displayed on screen?',
    },
  },
  {
    category: 'technical',
    field_key: 'device_and_os',
    priority: 3,
    is_required: true,
    session_mapping: 'device_model',
    labels: {
      'id-ID': 'Model HP & Versi OS',
      'th-TH': 'รุ่นอุปกรณ์และเวอร์ชัน OS',
      'fil-PH': 'Model ng Device at Bersyon ng OS',
      'ms-MY': 'Model Peranti & Versi OS',
      'vi-VN': 'Mẫu máy & Phiên bản OS',
      'en': 'Device Model and OS Version',
    },
    prompt_questions: {
      'id-ID': 'Apa tipe HP/perangkat dan versi OS yang sedang kamu gunakan?',
      'th-TH': 'ใช้อุปกรณ์รุ่นใดและเวอร์ชันของระบบปฏิบัติการ (OS) เท่าไรคะ/ครับ?',
      'fil-PH': 'Anong modelo ng device at bersyon ng OS ang iyong ginagamit?',
      'ms-MY': 'Apakah model peranti dan versi OS yang anda gunakan?',
      'vi-VN': 'Bạn đang sử dụng dòng máy nào và phiên bản hệ điều hành bao nhiêu?',
      'en': 'What device model and OS version are you using?',
    },
  },
  {
    category: 'technical',
    field_key: 'app_version',
    priority: 4,
    is_required: true,
    session_mapping: 'app_version',
    labels: {
      'id-ID': 'Versi Aplikasi Game',
      'th-TH': 'เวอร์ชันของแอปเกม',
      'fil-PH': 'Bersyon ng Game App',
      'ms-MY': 'Versi Aplikasi Permainan',
      'vi-VN': 'Phiên bản ứng dụng game',
      'en': 'Game App Version',
    },
    prompt_questions: {
      'id-ID': 'Berapa nomor versi aplikasi game yang terpasang saat ini?',
      'th-TH': 'เวอร์ชันของแอปเกมที่ติดตั้งอยู่ในปัจจุบันคือเวอร์ชันใดคะ/ครับ?',
      'fil-PH': 'Anong version ng game app ang kasalukuyang nakainstall sa device mo?',
      'ms-MY': 'Berapakah nombor versi aplikasi permainan yang dipasang sekarang?',
      'vi-VN': 'Phiên bản ứng dụng game hiện tại bạn đang cài đặt là bao nhiêu?',
      'en': 'What is the game app version currently installed?',
    },
  },
  {
    category: 'technical',
    field_key: 'connection_type',
    priority: 5,
    is_required: true,
    labels: {
      'id-ID': 'Tipe Koneksi Internet',
      'th-TH': 'ประเภทการเชื่อมต่อเน็ต',
      'fil-PH': 'Uri ng Koneksyon',
      'ms-MY': 'Jenis Sambungan Internet',
      'vi-VN': 'Loại kết nối mạng',
      'en': 'Internet Connection Type',
    },
    prompt_questions: {
      'id-ID': 'Kamu sedang bermain menggunakan jaringan apa (Wi-Fi, 4G, atau 5G)?',
      'th-TH': 'เชื่อมต่ออินเทอร์เน็ตผ่าน Wi-Fi หรือเครือข่ายมือถือ (4G/5G) คะ/ครับ?',
      'fil-PH': 'Gumagamit ka ba ng Wi-Fi o mobile data (4G/5G)?',
      'ms-MY': 'Adakah anda menggunakan sambungan Wi-Fi atau data mudah alih (4G/5G)?',
      'vi-VN': 'Bạn đang sử dụng mạng Wi-Fi hay dữ liệu di động (4G/5G)?',
      'en': 'Are you connected via Wi-Fi or mobile cellular data (4G/5G)?',
    },
  },
  {
    category: 'technical',
    field_key: 'is_reproducible',
    priority: 6,
    is_required: true,
    labels: {
      'id-ID': 'Keterulangan Kendala',
      'th-TH': 'การเกิดซ้ำของปัญหา',
      'fil-PH': 'Kadalasan ng Paglitaw',
      'ms-MY': 'Kekerapan Masalah',
      'vi-VN': 'Mức độ lặp lại sự cố',
      'en': 'Reproducibility',
    },
    prompt_questions: {
      'id-ID': 'Apakah kendala ini selalu berulang setiap dicoba, atau baru terjadi sekali ini saja?',
      'th-TH': 'ปัญหานี้เกิดขึ้นซ้ำทุกครั้งที่ลอง หรือเกิดขึ้นเพียงครั้งเดียวคะ/ครับ?',
      'fil-PH': 'Lagi po ba itong nauulit tuwing sinusubukan, o isang beses lang nangyari?',
      'ms-MY': 'Adakah masalah ini sentiasa berulang setiap kali dicuba, atau hanya sekali sahaja?',
      'vi-VN': 'Sự cố này có bị lặp lại mỗi khi bạn thử lại hay chỉ xảy ra một lần?',
      'en': 'Does this issue happen consistently every time, or only occurred once?',
    },
  },

  // =========================================================================
  // 4. GAMEPLAY & ITEM (gameplay_item)
  // =========================================================================
  {
    category: 'gameplay_item',
    field_key: 'item_or_feature_name',
    priority: 1,
    is_required: true,
    labels: {
      'id-ID': 'Nama Item / Fitur',
      'th-TH': 'ชื่อไอเทมหรือฟีเจอร์',
      'fil-PH': 'Pangalan ng Item o Feature',
      'ms-MY': 'Nama Item atau Ciri',
      'vi-VN': 'Tên vật phẩm hoặc tính năng',
      'en': 'Item or Feature Name',
    },
    prompt_questions: {
      'id-ID': 'Item, skin, atau fitur apa yang mengalami kendala?',
      'th-TH': 'ไอเทม สกิน หรือฟีเจอร์ใดที่มีปัญหาคะ/ครับ?',
      'fil-PH': 'Anong item, skin, o feature po ang may problema?',
      'ms-MY': 'Apakah nama item, skin, atau ciri yang bermasalah?',
      'vi-VN': 'Tên vật phẩm, trang phục hoặc tính năng nào gặp sự cố?',
      'en': 'What is the name of the item, skin, or feature involved?',
    },
  },
  {
    category: 'gameplay_item',
    field_key: 'event_name',
    priority: 2,
    is_required: false,
    labels: {
      'id-ID': 'Nama Event Terkait',
      'th-TH': 'ชื่ออีเวนต์ที่เกี่ยวข้อง',
      'fil-PH': 'Pangalan ng Event',
      'ms-MY': 'Nama Acara Terlibat',
      'vi-VN': 'Tên sự kiện liên quan',
      'en': 'Event Name (If Applicable)',
    },
    prompt_questions: {
      'id-ID': 'Apakah ini bagian dari event tertentu? Jika iya, apa nama event-nya?',
      'th-TH': 'เกี่ยวข้องกับกิจกรรม (Event) พิเศษใดไหมคะ/ครับ และชื่อกิจกรรมคืออะไร?',
      'fil-PH': 'Konektado po ba ito sa isang partikular na event? Kung oo, ano po ang pangalan nito?',
      'ms-MY': 'Adakah ini sebahagian daripada acara tertentu? Jika ya, apakah nama acara tersebut?',
      'vi-VN': 'Sự cố này có thuộc sự kiện cụ thể nào không? Nếu có, tên sự kiện là gì?',
      'en': 'Is this related to a specific event? If so, what is the event name?',
    },
  },
  {
    category: 'gameplay_item',
    field_key: 'incident_time',
    priority: 3,
    is_required: true,
    labels: {
      'id-ID': 'Waktu Kejadian',
      'th-TH': 'เวลาที่เกิดเหตุการณ์',
      'fil-PH': 'Oras ng Pangyayari',
      'ms-MY': 'Waktu Kejadian',
      'vi-VN': 'Thời gian xảy ra',
      'en': 'Time of Incident',
    },
    prompt_questions: {
      'id-ID': 'Kapan persisnya kejadian tersebut kamu alami di dalam game?',
      'th-TH': 'เหตุการณ์ดังกล่าวเกิดขึ้นเมื่อใดคะ/ครับ?',
      'fil-PH': 'Kailan po eksakto nangyari ito sa laro?',
      'ms-MY': 'Bilakah tepatnya kejadian ini berlaku dalam permainan?',
      'vi-VN': 'Chính xác bạn gặp sự việc này vào lúc nào trong game?',
      'en': 'When exactly did this occur in the game?',
    },
  },
  {
    category: 'gameplay_item',
    field_key: 'expected_vs_actual',
    priority: 4,
    is_required: true,
    labels: {
      'id-ID': 'Ekspektasi vs Kejadian Sebenarnya',
      'th-TH': 'สิ่งที่คาดหวังเทียบกับที่เกิดขึ้นจริง',
      'fil-PH': 'Inaasahan vs Aktwal na Nangyari',
      'ms-MY': 'Jangkaan vs Kejadian Sebenar',
      'vi-VN': 'Kỳ vọng so với thực tế xảy ra',
      'en': 'Expected vs Actual Outcome',
    },
    prompt_questions: {
      'id-ID': 'Bisa jelaskan apa yang seharusnya didapatkan vs apa yang sebenarnya muncul di game?',
      'th-TH': 'รบกวนอธิบายสิ่งที่ควรจะได้รับเทียบกับสิ่งที่เกิดขึ้นจริงในเกมได้ไหมคะ/ครับ?',
      'fil-PH': 'Maaari mo bang ipaliwanag kung ano ang inaasahan mong mangyari kumpara sa aktwal na nangyari?',
      'ms-MY': 'Bolehkah anda terangkan apa yang sepatutnya berlaku berbanding apa yang sebenarnya berlaku?',
      'vi-VN': 'Bạn có thể giải thích điều gì đáng lẽ phải nhận được so với thực tế xảy ra không?',
      'en': 'Could you describe what was expected to happen versus what actually occurred?',
    },
  },
  {
    category: 'gameplay_item',
    field_key: 'screenshot_proof',
    priority: 5,
    is_required: false,
    evidence_type: 'attachment',
    labels: {
      'id-ID': 'Screenshot / Bukti Visual',
      'th-TH': 'ภาพถ่ายหน้าจอ / หลักฐาน',
      'fil-PH': 'Screenshot o Katibayan',
      'ms-MY': 'Tangkapan Skrin / Bukti',
      'vi-VN': 'Ảnh chụp màn hình / Bằng chứng',
      'en': 'Screenshot or Visual Evidence',
    },
    prompt_questions: {
      'id-ID': 'Jika ada, silakan lampirkan tangkapan layar (screenshot) tampilan kendala tersebut.',
      'th-TH': 'หากมี กรุณาส่งภาพบันทึกหน้าจอ (Screenshot) ที่เห็นปัญหาเพื่อความรวดเร็วในการตรวจสอบค่ะ/ครับ',
      'fil-PH': 'Kung maaari, maglakip po ng screenshot ng naturang problema.',
      'ms-MY': 'Jika ada, sila lampirkan tangkapan skrin (screenshot) berkaitan masalah tersebut.',
      'vi-VN': 'Nếu có, bạn vui lòng đính kèm ảnh chụp màn hình thể hiện sự cố.',
      'en': 'If available, please attach a screenshot demonstrating the issue.',
    },
  },

  // =========================================================================
  // 5. FEEDBACK & LAINNYA (feedback_other)
  // Aturan Khusus: Deskripsi bebas, TIDAK ADA field wajib, bot TIDAK menginterogasi
  // =========================================================================
];

export class CategoryFieldService {
  /**
   * Menginisialisasi tabel database dan mengisi seed field set per kategori.
   */
  static async ensureTableAndSeed(pool: pg.Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS category_field_sets (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category         text NOT NULL,
        field_key        text NOT NULL,
        priority         int NOT NULL DEFAULT 0,
        is_required      boolean NOT NULL DEFAULT true,
        validation_regex text,
        session_mapping  text,
        evidence_type    text,
        labels           jsonb NOT NULL,
        prompt_questions jsonb NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (category, field_key)
      );
    `);

    const countRes = await pool.query('SELECT count(*)::int AS cnt FROM category_field_sets');
    if (countRes.rows[0].cnt === 0) {
      for (const f of SEED_CATEGORY_FIELDS) {
        await pool.query(
          `INSERT INTO category_field_sets (category, field_key, priority, is_required, validation_regex, session_mapping, evidence_type, labels, prompt_questions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (category, field_key) DO UPDATE SET
             priority = EXCLUDED.priority,
             is_required = EXCLUDED.is_required,
             validation_regex = EXCLUDED.validation_regex,
             session_mapping = EXCLUDED.session_mapping,
             evidence_type = EXCLUDED.evidence_type,
             labels = EXCLUDED.labels,
             prompt_questions = EXCLUDED.prompt_questions`,
          [
            f.category,
            f.field_key,
            f.priority,
            f.is_required,
            f.validation_regex || null,
            f.session_mapping || null,
            f.evidence_type || null,
            JSON.stringify(f.labels),
            JSON.stringify(f.prompt_questions),
          ]
        );
      }
    }
  }

  /**
   * Mengambil daftar field definition untuk kategori tertentu dari database.
   */
  static async getFieldsForCategory(pool: pg.Pool, category: string): Promise<CategoryFieldDefinition[]> {
    const res = await pool.query(
      `SELECT category, field_key, priority, is_required, validation_regex, session_mapping, evidence_type, labels, prompt_questions
       FROM category_field_sets
       WHERE category = $1
       ORDER BY priority ASC`,
      [category]
    );

    if (res.rows.length === 0) {
      // Fallback ke data in-memory jika belum pernah di-seed
      return SEED_CATEGORY_FIELDS.filter((f) => f.category === category).sort((a, b) => a.priority - b.priority);
    }

    return res.rows.map((r) => ({
      category: r.category,
      field_key: r.field_key,
      priority: r.priority,
      is_required: r.is_required,
      validation_regex: r.validation_regex,
      session_mapping: r.session_mapping,
      evidence_type: r.evidence_type,
      labels: typeof r.labels === 'string' ? JSON.parse(r.labels) : r.labels,
      prompt_questions: typeof r.prompt_questions === 'string' ? JSON.parse(r.prompt_questions) : r.prompt_questions,
    }));
  }

  /**
   * Otomatis mengisi field yang sudah diketahui dari konteks sesi terverifikasi
   * (UID, server, platform, app_version, device_model).
   * Syarat 4: Jangan tanyakan sesuatu yang sistem sudah tahu!
   */
  static populateSessionKnownFields(
    fields: CategoryFieldDefinition[],
    sessionContext: Record<string, any> = {},
    playerInfo?: Record<string, any> | null
  ): Record<string, string> {
    const filled: Record<string, string> = {};

    for (const field of fields) {
      if (!field.session_mapping) continue;

      switch (field.session_mapping) {
        case 'uid': {
          const uid = playerInfo?.uid || sessionContext?.uid || sessionContext?.player_uid;
          if (uid) filled[field.field_key] = String(uid);
          break;
        }
        case 'nickname': {
          const nick = playerInfo?.nickname || sessionContext?.nickname;
          if (nick) filled[field.field_key] = String(nick);
          break;
        }
        case 'server': {
          const srv = playerInfo?.server || sessionContext?.server;
          if (srv) filled[field.field_key] = String(srv);
          break;
        }
        case 'platform': {
          const plat = sessionContext?.platform || playerInfo?.platform;
          if (plat) filled[field.field_key] = String(plat);
          break;
        }
        case 'app_version': {
          const ver = sessionContext?.app_version || playerInfo?.app_version;
          if (ver) filled[field.field_key] = String(ver);
          break;
        }
        case 'device_model': {
          const dev = sessionContext?.device_model || sessionContext?.device || playerInfo?.device;
          if (dev) filled[field.field_key] = String(dev);
          break;
        }
      }
    }

    return filled;
  }

  /**
   * Otomatis memenuhi bukti (evidence field) jika ada attachment yang dikirim.
   * Syarat 5: Attachments satisfy the relevant evidence field automatically.
   */
  static satisfyAttachmentEvidence(
    fields: CategoryFieldDefinition[],
    currentCollected: Record<string, string>,
    attachmentUrl?: string
  ): { updated: Record<string, string>; satisfiedKey?: string } {
    const updated = { ...currentCollected };
    const evidenceField = fields.find(
      (f) => f.evidence_type === 'attachment' && !updated[f.field_key]
    );

    if (evidenceField) {
      const val = attachmentUrl || '[Lampiran Bukti Gambar/Struk Diterima]';
      updated[evidenceField.field_key] = val;
      return { updated, satisfiedKey: evidenceField.field_key };
    }

    return { updated };
  }

  /**
   * Mengambil field berikutnya yang wajib ditanyakan satu per satu secara berurutan.
   * Syarat 4 & 7: Satu per satu sesuai prioritas, dan untuk feedback_other TIDAK menginterogasi.
   */
  static getNextFieldToAsk(
    category: string,
    fields: CategoryFieldDefinition[],
    collected: Record<string, string>,
    locale = 'id-ID'
  ): { fieldKey: string; promptText: string; isComplete: boolean } | null {
    // Kategori feedback_other TIDAK pernah menginterogasi pemain (Syarat 7)
    if (category === 'feedback_other' || fields.length === 0) {
      return { fieldKey: '', promptText: '', isComplete: true };
    }

    const missingRequired = fields
      .filter((f) => f.is_required && !collected[f.field_key])
      .sort((a, b) => a.priority - b.priority);

    if (missingRequired.length === 0) {
      return { fieldKey: '', promptText: '', isComplete: true };
    }

    const nextField = missingRequired[0];
    const promptText =
      nextField.prompt_questions[locale] ||
      nextField.prompt_questions['id-ID'] ||
      nextField.prompt_questions['en'] ||
      'Mohon berikan informasi terkait hal ini.';

    return {
      fieldKey: nextField.field_key,
      promptText,
      isComplete: false,
      evidence_type: nextField.evidence_type || null,
      needs_evidence: nextField.evidence_type === 'attachment',
    };
  }

  /**
   * Menyusun ringkasan berkas kasus terstruktur untuk ditulis ke handoffs.bot_summary.
   * Syarat 6: All collected fields go into handoffs.bot_summary grouped by category.
   */
  static buildStructuredCaseFile(params: {
    category: string;
    fields: CategoryFieldDefinition[];
    collected: Record<string, string>;
    player?: any;
    reason?: string;
    locale?: string;
  }): string {
    const { category, fields, collected, player, reason, locale = 'id-ID' } = params;

    const categoryNames: Record<string, string> = {
      account_login: 'Akun & Login',
      payment_topup: 'Pembayaran & Top-up',
      technical: 'Teknis',
      gameplay_item: 'Gameplay & Item',
      feedback_other: 'Feedback & Lainnya',
    };

    const categoryTitle = categoryNames[category] || category;
    const lines: string[] = [];

    lines.push(`=== [KASUS TIKET LIVECHAT: ${categoryTitle.toUpperCase()}] ===`);
    if (reason) {
      lines.push(`Alasan Eskalasi: ${reason}`);
    }

    // Profil Pemain Terverifikasi
    if (player) {
      lines.push(`\n[Profil Pemain Terverifikasi]`);
      lines.push(`- UID: ${player.uid || '-'}`);
      if (player.nickname) lines.push(`- Nickname: ${player.nickname}`);
      if (player.server) lines.push(`- Server: ${player.server}`);
      if (player.level) lines.push(`- Level: ${player.level}`);
      if (player.vip_tier !== undefined) lines.push(`- VIP Tier: ${player.vip_tier}`);
    }

    // Data Terkumpul Dikelompokkan Berdasarkan Kategori
    lines.push(`\n[Data Investigasi Kategori: ${categoryTitle}]`);

    if (category === 'feedback_other') {
      const desc = collected.feedback_text || collected.description || collected.notes || 'Catatan pemain langsung diteruskan tanpa interogasi.';
      lines.push(`- Deskripsi Feedback: ${desc}`);
    } else if (fields.length === 0) {
      lines.push(`- Tidak ada field investigasi khusus.`);
    } else {
      for (const f of fields) {
        const label = f.labels[locale] || f.labels['id-ID'] || f.labels['en'] || f.field_key;
        const val = collected[f.field_key];
        const statusMark = val ? `[TERISI] ${val}` : f.is_required ? `[BELUM ADA - WAJIB]` : `[OPSIONAL - KOSONG]`;
        lines.push(`- ${label}: ${statusMark}`);
      }
    }

    return lines.join('\n');
  }
}
