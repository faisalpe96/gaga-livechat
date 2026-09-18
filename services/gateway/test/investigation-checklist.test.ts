import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db.js';
import { CategoryFieldService, SEED_CATEGORY_FIELDS } from '../src/category-field-service.js';

describe('Investigation Checklist & Field Collection Tests', { timeout: 20000 }, () => {
  let db: Database;

  before(async () => {
    db = new Database();
    await db.ensureInvestigationAndScheduleTables();
  });

  after(async () => {
    await db.close();
  });

  test('1. Correct field set per category: Memuat field set yang tepat dari database untuk setiap kategori', async () => {
    // a. Akun & Login (account_login)
    const accountFields = await db.getCategoryFieldDefinitions('account_login');
    const accountKeys = accountFields.map((f) => f.field_key);
    assert.deepStrictEqual(
      accountKeys,
      ['nickname_or_uid', 'login_issue_desc', 'last_login_time', 'login_method', 'device_info', 'error_message'],
      'Field set Akun & Login harus sesuai dengan spesifikasi'
    );
    // Pastikan field memiliki label lokal di seluruh 6 bahasa
    const nickField = accountFields.find((f) => f.field_key === 'nickname_or_uid')!;
    assert.ok(nickField.labels['id-ID'], 'Harus ada label id-ID');
    assert.ok(nickField.labels['th-TH'], 'Harus ada label th-TH');
    assert.ok(nickField.labels['en'], 'Harus ada label en');

    // b. Pembayaran & Top-up (payment_topup)
    const paymentFields = await db.getCategoryFieldDefinitions('payment_topup');
    const paymentKeys = paymentFields.map((f) => f.field_key);
    assert.deepStrictEqual(
      paymentKeys,
      ['order_id', 'amount', 'payment_method', 'transaction_time', 'balance_deducted'],
      'Field set Pembayaran & Top-up harus mencakup 5 field'
    );

    // c. Teknis (technical)
    const techFields = await db.getCategoryFieldDefinitions('technical');
    const techKeys = techFields.map((f) => f.field_key);
    assert.deepStrictEqual(
      techKeys,
      ['activity_when_happened', 'error_code_or_msg', 'device_and_os', 'app_version', 'connection_type', 'is_reproducible'],
      'Field set Teknis harus mencakup 6 field'
    );

    // d. Gameplay & Item (gameplay_item)
    const gameplayFields = await db.getCategoryFieldDefinitions('gameplay_item');
    const gameplayKeys = gameplayFields.map((f) => f.field_key);
    assert.deepStrictEqual(
      gameplayKeys,
      ['item_or_feature_name', 'event_name', 'incident_time', 'expected_vs_actual', 'screenshot_proof'],
      'Field set Gameplay & Item harus mencakup 5 field'
    );
  });

  test('2. Free-text category (feedback_other) NEVER triggers a field checklist or bot interrogation', async () => {
    const feedbackFields = await db.getCategoryFieldDefinitions('feedback_other');
    assert.strictEqual(feedbackFields.length, 0, 'Kategori feedback_other tidak boleh memiliki field wajib');

    // Evaluasi bot question untuk feedback_other
    const nextQuestion = CategoryFieldService.getNextFieldToAsk('feedback_other', feedbackFields, {}, 'id-ID');
    assert.strictEqual(nextQuestion?.isComplete, true, 'Kategori feedback harus langsung dianggap selesai');
    assert.strictEqual(nextQuestion?.fieldKey, '', 'Bot DILARANG menginterogasi pemain untuk feedback_other');
  });

  test('3. Session-known fields are automatically skipped and filled from verified session context', async () => {
    // Skenario Akun & Login: UID sudah terverifikasi di session context
    const accountFields = await db.getCategoryFieldDefinitions('account_login');
    const sessionContext = {
      app_version: 'v2.1.0',
      device_model: 'Samsung S24 Ultra',
    };
    const playerInfo = {
      uid: '88392019',
      nickname: 'ProSniper',
      server: 'SEA-2',
    };

    const sessionFilled = CategoryFieldService.populateSessionKnownFields(
      accountFields,
      sessionContext,
      playerInfo
    );

    assert.strictEqual(sessionFilled.nickname_or_uid, '88392019', 'UID wajib terisi otomatis dari sesi pemain');
    assert.strictEqual(sessionFilled.device_info, 'Samsung S24 Ultra', 'Device wajib terisi otomatis dari context');

    // Cek pertanyaan berikutnya: field yang sudah diketahui dari sesi tidak boleh ditanyakan lagi!
    const nextToAsk = CategoryFieldService.getNextFieldToAsk(
      'account_login',
      accountFields,
      sessionFilled,
      'id-ID'
    );

    assert.notStrictEqual(nextToAsk?.fieldKey, 'nickname_or_uid', 'UID tidak boleh ditanyakan karena sudah diketahui sistem');
    assert.strictEqual(nextToAsk?.fieldKey, 'login_issue_desc', 'Bot harus langsung melompat ke field yang belum diketahui');
  });

  test('4. No restart on category switch: Nilai field yang sudah terkumpul tetap tersimpan saat berganti kategori', async () => {
    // Awalnya pemain di kategori payment_topup dan sudah mengisi order_id & amount
    const initialCollected: Record<string, string> = {
      order_id: '#GG83749',
      amount: 'Rp 50.000',
    };

    // Pemain berpindah ke kategori technical
    const techFields = await db.getCategoryFieldDefinitions('technical');
    const sessionFields = CategoryFieldService.populateSessionKnownFields(
      techFields,
      { app_version: '1.0.0', device_model: 'ROG Phone' },
      { uid: '77124490' }
    );

    // Gabungkan (seperti yang dilakukan pada event set_category di WebSocketHub)
    const merged = { ...initialCollected, ...sessionFields };

    assert.strictEqual(merged.order_id, '#GG83749', 'Data Order ID sebelumnya tidak boleh hilang saat ganti kategori');
    assert.strictEqual(merged.amount, 'Rp 50.000', 'Data nominal sebelumnya tetap utuh');
    assert.strictEqual(merged.app_version, '1.0.0', 'Data sesi baru otomatis terisi');
  });

  test('5. Attachments satisfy the relevant evidence field automatically', async () => {
    // Kategori payment_topup memiliki evidence_type: 'attachment' pada order_id
    const paymentFields = await db.getCategoryFieldDefinitions('payment_topup');
    const currentCollected: Record<string, string> = {};

    const { updated, satisfiedKey } = CategoryFieldService.satisfyAttachmentEvidence(
      paymentFields,
      currentCollected,
      'https://gaga.games/uploads/receipt_9921.jpg'
    );

    assert.strictEqual(satisfiedKey, 'order_id', 'Attachment harus memenuhi field bukti order_id');
    assert.strictEqual(updated.order_id, 'https://gaga.games/uploads/receipt_9921.jpg');

    // Kategori gameplay_item memiliki evidence_type: 'attachment' pada screenshot_proof
    const gameplayFields = await db.getCategoryFieldDefinitions('gameplay_item');
    const resGameplay = CategoryFieldService.satisfyAttachmentEvidence(
      gameplayFields,
      {},
      'https://gaga.games/uploads/bug_screen.png'
    );
    assert.strictEqual(resGameplay.satisfiedKey, 'screenshot_proof', 'Attachment harus memenuhi screenshot_proof');
  });

  test('6. All collected fields go into handoffs.bot_summary grouped by category (structured case file)', async () => {
    const fields = await db.getCategoryFieldDefinitions('payment_topup');
    const collected = {
      order_id: '#GG10293',
      amount: 'Rp 100.000',
      payment_method: 'DANA',
      transaction_time: '12:45 WIB',
      balance_deducted: 'Sudah terpotong',
    };

    const caseFile = CategoryFieldService.buildStructuredCaseFile({
      category: 'payment_topup',
      fields,
      collected,
      player: { uid: '77124490', nickname: 'RyuHunter', server: 'SEA-3', vip_tier: 4 },
      reason: 'topup_uncredited',
      locale: 'id-ID',
    });

    assert.ok(caseFile.includes('KASUS TIKET LIVECHAT: PEMBAYARAN & TOP-UP'), 'Harus memiliki header kategori');
    assert.ok(caseFile.includes('UID: 77124490'), 'Harus menyertakan konteks sesi terverifikasi');
    assert.ok(caseFile.includes('Nickname: RyuHunter'));
    assert.ok(caseFile.includes('#GG10293'), 'Harus menyertakan nilai field order_id');
    assert.ok(caseFile.includes('DANA'), 'Harus menyertakan metode pembayaran');
    assert.ok(caseFile.includes('Data Investigasi Kategori: Pembayaran & Top-up'), 'Harus terkelompok berdasarkan kategori');
  });
});
