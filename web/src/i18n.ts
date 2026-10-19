/**
 * Translations for the hosted payment pages (Checkout, invoices, receipts).
 * Checkout Sessions pick the language with `locale`; invoices follow the customer's
 * `preferred_locales`; `auto` follows the browser. Customers can switch from the page footer.
 */
export const LANGUAGES = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', ja: '日本語' } as const;
export type Lang = keyof typeof LANGUAGES;

const en = {
  pay_merchant: 'Pay {merchant}', subscribe_to: 'Subscribe to {item}', total_due: 'Total due', total_due_today: 'Total due today', subtotal: 'Subtotal',
  shipping: 'Shipping', free: 'Free', tax: 'Tax', enter_address_tax: 'Enter address to calculate', billed: 'billed {interval}', usage: 'Usage', billed_on_usage: 'billed on usage',
  trial: "{days}-day free trial. You won't be charged today.", add_promo: 'Add promotion code', promo: 'Promotion code', apply: 'Apply', remove_promo: 'Remove promotion code',
  reverse_charge: "Reverse charge: VAT isn't added because you're buying as a VAT-registered business. You account for VAT yourself.",
  payment_method: 'Payment method', pay_with_card: 'Pay with card', save_your_card: 'Save your card', setup_note: "You won't be charged now. {merchant} will use this card for future payments.",
  email: 'Email', card_info: 'Card information', name_on_card: 'Name on card', full_name: 'Full name', billing_address: 'Billing address', address: 'Address', city: 'City', country: 'Country',
  state: 'State', province: 'Province', postal: 'Postal code', shipping_address: 'Shipping address', shipping_method: 'Shipping method', shipping_country: 'Shipping country',
  pay_amount: 'Pay {amount}', subscribe: 'Subscribe', start_trial: 'Start trial', save_card: 'Save card', processing: 'Processing…', cancel_return: 'Cancel and return', test_cards: 'Test card numbers',
  business: "I'm purchasing as a business", tax_id_type: 'Tax ID type', tax_id: 'Tax ID', select: 'Select…', optional: '(optional)',
  promotions: 'Keep me updated with news and offers from {merchant}.', terms: "I agree to {merchant}'s Terms of Service.",
  m_card: 'Card', m_bank: 'US bank account', m_quartet: 'Pay in 4', wallet: 'Pay with wallet', or_other: 'Or pay another way',
  link_bank: 'Link your bank', manual_bank: 'Enter bank details manually', routing: 'Routing number', account_no: 'Account number', account_type: 'Account type', checking: 'Checking', savings: 'Savings',
  linked: '{bank} •••• {last4}', change: 'Change', bank_name: 'Account holder name', instant_badge: 'Verified instantly',
  mandate: 'By paying, you authorize {merchant} to debit the bank account above for {amount}, and to make corrections if a debit is made in error. You can revoke this authorization by contacting {merchant}.',
  verify_title: 'Verify your bank account', verify_body: 'Two small deposits were sent to your account (in test mode they arrive at once). Enter them to finish your payment.', verify_now: 'Verify bank account',
  quartet_line: '4 interest-free payments of {amount}', quartet_note: "You'll continue to Quartet to approve your payment plan. No impact on your credit score in test mode.", continue_quartet: 'Continue to Quartet',
  save_oneclick: 'Save my details for one-click checkout', save_oneclick_note: 'Next time, pay at any business that uses Tessera with a code sent to your email.',
  welcome_back: 'Welcome back! Enter the code sent to {email}.', code: 'Verification code', not_you: 'Not you?', signed_in: 'Signed in as {email}', use_other: 'Pay another way',
  code_hint: 'Test mode: 000000 works, or find the code in Developers → Emails.', pay_saved: 'Pay {amount}', saved_cards: 'Saved cards', remove: 'Remove', expires: 'Expires {date}',
  paid_title: 'Payment complete', paid_body: 'Thanks! {amount} was paid to {merchant}.', sub_title: 'Subscription started', sub_body: "You're subscribed to {item}. A receipt is on its way.",
  setup_title: 'Card saved', setup_body: '{merchant} can now charge this card for future purchases.', continue: 'Continue', redirecting: 'Redirecting…',
  processing_title: 'Payment processing', processing_body: '{merchant} will confirm your bank payment of {amount} when it clears (usually within 4 business days).',
  async_failed: 'Your bank payment to {merchant} did not go through. Contact {merchant} to pay another way.',
  link_status: 'This payment link has {status}.', language: 'Language', currency: 'Currency', pay_in: 'Pay in {currency}',
  converted: 'Converted at 1 {from} = {rate} {to}, including a 2% conversion fee. Your bank may charge its own fees.', test_mode: 'Test mode',
  invoice_no: 'Invoice {number}', due_on: 'Due {date}', download_pdf: 'Download invoice PDF', amount_due: 'Amount due', remaining: 'Remaining', paid_so_far: 'Paid so far', discount: 'Discount',
  schedule: 'Payment schedule', installment: 'Installment {n}', paid_on: 'Paid {date}', overdue: 'overdue', paid: 'Paid', pay_invoice: 'Pay invoice', invoice_paid: 'Invoice paid',
  invoice_paid_body: '{amount} paid to {merchant}. Thank you!', invoice_status: 'This invoice is {status}.', pay_next: 'Pay {what}: {amount}', next_installment: 'next installment', pay_full: 'Pay the full remaining {amount}',
  reverse_charge_short: 'Reverse charge: the customer accounts for VAT.',
};
type Dict = typeof en;

const de: Dict = {
  pay_merchant: 'An {merchant} zahlen', subscribe_to: '{item} abonnieren', total_due: 'Gesamtbetrag', total_due_today: 'Heute fällig', subtotal: 'Zwischensumme',
  shipping: 'Versand', free: 'Kostenlos', tax: 'Steuer', enter_address_tax: 'Adresse eingeben zur Berechnung', billed: 'Abrechnung {interval}', usage: 'Nutzung', billed_on_usage: 'nach Nutzung abgerechnet',
  trial: '{days} Tage kostenlos testen. Heute wird nichts belastet.', add_promo: 'Gutscheincode hinzufügen', promo: 'Gutscheincode', apply: 'Anwenden', remove_promo: 'Gutscheincode entfernen',
  reverse_charge: 'Steuerschuldnerschaft des Leistungsempfängers: Es wird keine USt. berechnet, da Sie als umsatzsteuerlich registriertes Unternehmen kaufen.',
  payment_method: 'Zahlungsmethode', pay_with_card: 'Mit Karte zahlen', save_your_card: 'Karte speichern', setup_note: 'Es wird jetzt nichts belastet. {merchant} verwendet diese Karte für künftige Zahlungen.',
  email: 'E-Mail', card_info: 'Kartendaten', name_on_card: 'Name auf der Karte', full_name: 'Vollständiger Name', billing_address: 'Rechnungsadresse', address: 'Adresse', city: 'Stadt', country: 'Land',
  state: 'Bundesstaat', province: 'Provinz', postal: 'Postleitzahl', shipping_address: 'Lieferadresse', shipping_method: 'Versandart', shipping_country: 'Lieferland',
  pay_amount: '{amount} zahlen', subscribe: 'Abonnieren', start_trial: 'Test starten', save_card: 'Karte speichern', processing: 'Wird verarbeitet…', cancel_return: 'Abbrechen und zurück', test_cards: 'Testkartennummern',
  business: 'Ich kaufe als Unternehmen', tax_id_type: 'Art der Steuernummer', tax_id: 'Steuernummer', select: 'Auswählen…', optional: '(optional)',
  promotions: 'Ich möchte Neuigkeiten und Angebote von {merchant} erhalten.', terms: 'Ich stimme den AGB von {merchant} zu.',
  m_card: 'Karte', m_bank: 'US-Bankkonto', m_quartet: 'In 4 Raten', wallet: 'Mit Wallet zahlen', or_other: 'Oder anders bezahlen',
  link_bank: 'Bank verknüpfen', manual_bank: 'Bankdaten manuell eingeben', routing: 'Bankleitzahl (Routing)', account_no: 'Kontonummer', account_type: 'Kontoart', checking: 'Girokonto', savings: 'Sparkonto',
  linked: '{bank} •••• {last4}', change: 'Ändern', bank_name: 'Name des Kontoinhabers', instant_badge: 'Sofort verifiziert',
  mandate: 'Mit der Zahlung ermächtigen Sie {merchant}, das obige Bankkonto mit {amount} zu belasten und fehlerhafte Belastungen zu korrigieren. Sie können dies jederzeit bei {merchant} widerrufen.',
  verify_title: 'Bankkonto bestätigen', verify_body: 'Zwei kleine Gutschriften wurden auf Ihr Konto gesendet (im Testmodus sofort). Geben Sie sie ein, um die Zahlung abzuschließen.', verify_now: 'Bankkonto bestätigen',
  quartet_line: '4 zinsfreie Raten à {amount}', quartet_note: 'Sie werden zu Quartet weitergeleitet, um den Ratenplan zu bestätigen.', continue_quartet: 'Weiter zu Quartet',
  save_oneclick: 'Meine Daten für Ein-Klick-Checkout speichern', save_oneclick_note: 'Zahlen Sie künftig bei allen Tessera-Händlern mit einem Code per E-Mail.',
  welcome_back: 'Willkommen zurück! Geben Sie den an {email} gesendeten Code ein.', code: 'Bestätigungscode', not_you: 'Nicht Sie?', signed_in: 'Angemeldet als {email}', use_other: 'Anders bezahlen',
  code_hint: 'Testmodus: 000000 funktioniert, oder den Code unter Entwickler → E-Mails finden.', pay_saved: '{amount} zahlen', saved_cards: 'Gespeicherte Karten', remove: 'Entfernen', expires: 'Gültig bis {date}',
  paid_title: 'Zahlung abgeschlossen', paid_body: 'Danke! {amount} wurde an {merchant} gezahlt.', sub_title: 'Abonnement gestartet', sub_body: 'Sie haben {item} abonniert. Ein Beleg ist unterwegs.',
  setup_title: 'Karte gespeichert', setup_body: '{merchant} kann diese Karte nun für künftige Käufe belasten.', continue: 'Weiter', redirecting: 'Weiterleitung…',
  processing_title: 'Zahlung in Bearbeitung', processing_body: '{merchant} bestätigt Ihre Bankzahlung über {amount}, sobald sie eingegangen ist (meist innerhalb von 4 Werktagen).',
  async_failed: 'Ihre Bankzahlung an {merchant} ist fehlgeschlagen. Bitte wenden Sie sich an {merchant}.',
  link_status: 'Dieser Zahlungslink ist {status}.', language: 'Sprache', currency: 'Währung', pay_in: 'In {currency} zahlen',
  converted: 'Umgerechnet zu 1 {from} = {rate} {to}, inklusive 2 % Umrechnungsgebühr. Ihre Bank kann eigene Gebühren erheben.', test_mode: 'Testmodus',
  invoice_no: 'Rechnung {number}', due_on: 'Fällig am {date}', download_pdf: 'Rechnung als PDF', amount_due: 'Fälliger Betrag', remaining: 'Restbetrag', paid_so_far: 'Bereits bezahlt', discount: 'Rabatt',
  schedule: 'Zahlungsplan', installment: 'Rate {n}', paid_on: 'Bezahlt am {date}', overdue: 'überfällig', paid: 'Bezahlt', pay_invoice: 'Rechnung bezahlen', invoice_paid: 'Rechnung bezahlt',
  invoice_paid_body: '{amount} an {merchant} gezahlt. Vielen Dank!', invoice_status: 'Diese Rechnung ist {status}.', pay_next: '{what} zahlen: {amount}', next_installment: 'Nächste Rate', pay_full: 'Den gesamten Restbetrag von {amount} zahlen',
  reverse_charge_short: 'Steuerschuldnerschaft des Leistungsempfängers.',
};

const fr: Dict = {
  pay_merchant: 'Payer {merchant}', subscribe_to: "S'abonner à {item}", total_due: 'Total à payer', total_due_today: "À payer aujourd'hui", subtotal: 'Sous-total',
  shipping: 'Livraison', free: 'Gratuit', tax: 'Taxe', enter_address_tax: "Saisissez l'adresse pour calculer", billed: 'facturé {interval}', usage: 'Utilisation', billed_on_usage: "facturé à l'utilisation",
  trial: "Essai gratuit de {days} jours. Vous ne serez pas débité aujourd'hui.", add_promo: 'Ajouter un code promo', promo: 'Code promo', apply: 'Appliquer', remove_promo: 'Retirer le code promo',
  reverse_charge: "Autoliquidation : la TVA n'est pas ajoutée car vous achetez en tant qu'entreprise assujettie.",
  payment_method: 'Moyen de paiement', pay_with_card: 'Payer par carte', save_your_card: 'Enregistrer votre carte', setup_note: "Vous ne serez pas débité maintenant. {merchant} utilisera cette carte pour vos prochains paiements.",
  email: 'E-mail', card_info: 'Informations de carte', name_on_card: 'Nom sur la carte', full_name: 'Nom complet', billing_address: 'Adresse de facturation', address: 'Adresse', city: 'Ville', country: 'Pays',
  state: 'État', province: 'Province', postal: 'Code postal', shipping_address: 'Adresse de livraison', shipping_method: 'Mode de livraison', shipping_country: 'Pays de livraison',
  pay_amount: 'Payer {amount}', subscribe: "S'abonner", start_trial: "Commencer l'essai", save_card: 'Enregistrer la carte', processing: 'Traitement…', cancel_return: 'Annuler et revenir', test_cards: 'Numéros de carte de test',
  business: "J'achète en tant qu'entreprise", tax_id_type: "Type d'identifiant fiscal", tax_id: 'Identifiant fiscal', select: 'Choisir…', optional: '(facultatif)',
  promotions: "Recevoir les actualités et offres de {merchant}.", terms: "J'accepte les conditions d'utilisation de {merchant}.",
  m_card: 'Carte', m_bank: 'Compte bancaire US', m_quartet: 'Payer en 4 fois', wallet: 'Payer avec le portefeuille', or_other: 'Ou payer autrement',
  link_bank: 'Associer votre banque', manual_bank: 'Saisir les coordonnées bancaires', routing: "Numéro d'acheminement", account_no: 'Numéro de compte', account_type: 'Type de compte', checking: 'Courant', savings: 'Épargne',
  linked: '{bank} •••• {last4}', change: 'Modifier', bank_name: 'Titulaire du compte', instant_badge: 'Vérifié instantanément',
  mandate: "En payant, vous autorisez {merchant} à prélever {amount} sur le compte ci-dessus et à corriger tout prélèvement erroné. Vous pouvez révoquer cette autorisation auprès de {merchant}.",
  verify_title: 'Vérifiez votre compte bancaire', verify_body: 'Deux petits dépôts ont été envoyés sur votre compte (immédiats en mode test). Saisissez-les pour finaliser le paiement.', verify_now: 'Vérifier le compte',
  quartet_line: '4 paiements sans frais de {amount}', quartet_note: 'Vous continuerez sur Quartet pour approuver votre échéancier.', continue_quartet: 'Continuer vers Quartet',
  save_oneclick: 'Enregistrer mes informations pour le paiement en un clic', save_oneclick_note: "La prochaine fois, payez chez tout marchand Tessera avec un code envoyé par e-mail.",
  welcome_back: 'Bon retour ! Saisissez le code envoyé à {email}.', code: 'Code de vérification', not_you: "Ce n'est pas vous ?", signed_in: 'Connecté : {email}', use_other: 'Payer autrement',
  code_hint: 'Mode test : 000000 fonctionne, ou trouvez le code dans Développeurs → E-mails.', pay_saved: 'Payer {amount}', saved_cards: 'Cartes enregistrées', remove: 'Retirer', expires: 'Expire le {date}',
  paid_title: 'Paiement effectué', paid_body: 'Merci ! {amount} a été payé à {merchant}.', sub_title: 'Abonnement démarré', sub_body: 'Vous êtes abonné à {item}. Un reçu arrive.',
  setup_title: 'Carte enregistrée', setup_body: '{merchant} peut désormais débiter cette carte pour vos prochains achats.', continue: 'Continuer', redirecting: 'Redirection…',
  processing_title: 'Paiement en cours', processing_body: '{merchant} confirmera votre paiement bancaire de {amount} une fois reçu (en général sous 4 jours ouvrés).',
  async_failed: "Votre paiement bancaire à {merchant} n'a pas abouti. Contactez {merchant}.",
  link_status: 'Ce lien de paiement est {status}.', language: 'Langue', currency: 'Devise', pay_in: 'Payer en {currency}',
  converted: 'Converti à 1 {from} = {rate} {to}, frais de conversion de 2 % inclus. Votre banque peut appliquer ses propres frais.', test_mode: 'Mode test',
  invoice_no: 'Facture {number}', due_on: 'Échéance le {date}', download_pdf: 'Télécharger la facture PDF', amount_due: 'Montant dû', remaining: 'Reste à payer', paid_so_far: 'Déjà payé', discount: 'Remise',
  schedule: 'Échéancier', installment: 'Échéance {n}', paid_on: 'Payé le {date}', overdue: 'en retard', paid: 'Payé', pay_invoice: 'Payer la facture', invoice_paid: 'Facture payée',
  invoice_paid_body: '{amount} payé à {merchant}. Merci !', invoice_status: 'Cette facture est {status}.', pay_next: 'Payer {what} : {amount}', next_installment: 'la prochaine échéance', pay_full: 'Payer la totalité restante de {amount}',
  reverse_charge_short: 'Autoliquidation : le client déclare la TVA.',
};

const es: Dict = {
  pay_merchant: 'Pagar a {merchant}', subscribe_to: 'Suscribirse a {item}', total_due: 'Total a pagar', total_due_today: 'A pagar hoy', subtotal: 'Subtotal',
  shipping: 'Envío', free: 'Gratis', tax: 'Impuesto', enter_address_tax: 'Introduce la dirección para calcular', billed: 'facturado {interval}', usage: 'Uso', billed_on_usage: 'facturado según el uso',
  trial: 'Prueba gratuita de {days} días. Hoy no se te cobrará.', add_promo: 'Añadir código promocional', promo: 'Código promocional', apply: 'Aplicar', remove_promo: 'Quitar código promocional',
  reverse_charge: 'Inversión del sujeto pasivo: no se añade IVA porque compras como empresa registrada.',
  payment_method: 'Método de pago', pay_with_card: 'Pagar con tarjeta', save_your_card: 'Guarda tu tarjeta', setup_note: 'No se te cobrará ahora. {merchant} usará esta tarjeta para pagos futuros.',
  email: 'Correo electrónico', card_info: 'Datos de la tarjeta', name_on_card: 'Nombre en la tarjeta', full_name: 'Nombre completo', billing_address: 'Dirección de facturación', address: 'Dirección', city: 'Ciudad', country: 'País',
  state: 'Estado', province: 'Provincia', postal: 'Código postal', shipping_address: 'Dirección de envío', shipping_method: 'Método de envío', shipping_country: 'País de envío',
  pay_amount: 'Pagar {amount}', subscribe: 'Suscribirse', start_trial: 'Empezar prueba', save_card: 'Guardar tarjeta', processing: 'Procesando…', cancel_return: 'Cancelar y volver', test_cards: 'Números de tarjeta de prueba',
  business: 'Compro como empresa', tax_id_type: 'Tipo de identificación fiscal', tax_id: 'Identificación fiscal', select: 'Selecciona…', optional: '(opcional)',
  promotions: 'Quiero recibir novedades y ofertas de {merchant}.', terms: 'Acepto los Términos del servicio de {merchant}.',
  m_card: 'Tarjeta', m_bank: 'Cuenta bancaria de EE. UU.', m_quartet: 'Paga en 4', wallet: 'Pagar con billetera', or_other: 'O paga de otra forma',
  link_bank: 'Vincular tu banco', manual_bank: 'Introducir datos bancarios', routing: 'Número de ruta', account_no: 'Número de cuenta', account_type: 'Tipo de cuenta', checking: 'Corriente', savings: 'Ahorros',
  linked: '{bank} •••• {last4}', change: 'Cambiar', bank_name: 'Titular de la cuenta', instant_badge: 'Verificada al instante',
  mandate: 'Al pagar, autorizas a {merchant} a cargar {amount} en la cuenta indicada y a corregir cargos erróneos. Puedes revocar esta autorización contactando con {merchant}.',
  verify_title: 'Verifica tu cuenta bancaria', verify_body: 'Enviamos dos pequeños depósitos a tu cuenta (inmediatos en modo de prueba). Introdúcelos para completar el pago.', verify_now: 'Verificar cuenta',
  quartet_line: '4 pagos sin intereses de {amount}', quartet_note: 'Continuarás en Quartet para aprobar tu plan de pagos.', continue_quartet: 'Continuar a Quartet',
  save_oneclick: 'Guardar mis datos para pagar con un clic', save_oneclick_note: 'La próxima vez, paga en cualquier comercio con Tessera con un código enviado a tu correo.',
  welcome_back: '¡Hola de nuevo! Introduce el código enviado a {email}.', code: 'Código de verificación', not_you: '¿No eres tú?', signed_in: 'Sesión iniciada como {email}', use_other: 'Pagar de otra forma',
  code_hint: 'Modo de prueba: 000000 funciona, o busca el código en Desarrolladores → Correos.', pay_saved: 'Pagar {amount}', saved_cards: 'Tarjetas guardadas', remove: 'Quitar', expires: 'Caduca {date}',
  paid_title: 'Pago completado', paid_body: '¡Gracias! Se pagaron {amount} a {merchant}.', sub_title: 'Suscripción iniciada', sub_body: 'Te has suscrito a {item}. Recibirás un recibo.',
  setup_title: 'Tarjeta guardada', setup_body: '{merchant} ya puede cobrar en esta tarjeta tus compras futuras.', continue: 'Continuar', redirecting: 'Redirigiendo…',
  processing_title: 'Pago en proceso', processing_body: '{merchant} confirmará tu pago bancario de {amount} cuando se acredite (normalmente en 4 días hábiles).',
  async_failed: 'Tu pago bancario a {merchant} no se completó. Contacta con {merchant}.',
  link_status: 'Este enlace de pago está {status}.', language: 'Idioma', currency: 'Moneda', pay_in: 'Pagar en {currency}',
  converted: 'Convertido a 1 {from} = {rate} {to}, con una comisión de conversión del 2 %. Tu banco puede cobrar sus propias comisiones.', test_mode: 'Modo de prueba',
  invoice_no: 'Factura {number}', due_on: 'Vence el {date}', download_pdf: 'Descargar factura en PDF', amount_due: 'Importe a pagar', remaining: 'Pendiente', paid_so_far: 'Pagado hasta ahora', discount: 'Descuento',
  schedule: 'Calendario de pagos', installment: 'Plazo {n}', paid_on: 'Pagado el {date}', overdue: 'vencido', paid: 'Pagado', pay_invoice: 'Pagar factura', invoice_paid: 'Factura pagada',
  invoice_paid_body: 'Se pagaron {amount} a {merchant}. ¡Gracias!', invoice_status: 'Esta factura está {status}.', pay_next: 'Pagar {what}: {amount}', next_installment: 'el próximo plazo', pay_full: 'Pagar el total pendiente de {amount}',
  reverse_charge_short: 'Inversión del sujeto pasivo: el cliente declara el IVA.',
};

const ja: Dict = {
  pay_merchant: '{merchant}へのお支払い', subscribe_to: '{item}に登録', total_due: 'お支払い合計', total_due_today: '本日のお支払い', subtotal: '小計',
  shipping: '配送料', free: '無料', tax: '税', enter_address_tax: '住所を入力すると計算されます', billed: '{interval}請求', usage: '使用量', billed_on_usage: '使用量に応じて請求',
  trial: '{days}日間の無料トライアル。本日の請求はありません。', add_promo: 'プロモーションコードを追加', promo: 'プロモーションコード', apply: '適用', remove_promo: 'プロモーションコードを削除',
  reverse_charge: 'リバースチャージ：VAT登録事業者としての購入のため、VATは加算されません。',
  payment_method: 'お支払い方法', pay_with_card: 'カードで支払う', save_your_card: 'カードを保存', setup_note: '今は請求されません。{merchant}は今後のお支払いにこのカードを使用します。',
  email: 'メールアドレス', card_info: 'カード情報', name_on_card: 'カード名義', full_name: '氏名', billing_address: '請求先住所', address: '住所', city: '市区町村', country: '国',
  state: '州', province: '州', postal: '郵便番号', shipping_address: '配送先住所', shipping_method: '配送方法', shipping_country: '配送先の国',
  pay_amount: '{amount}を支払う', subscribe: '登録する', start_trial: 'トライアルを開始', save_card: 'カードを保存', processing: '処理中…', cancel_return: 'キャンセルして戻る', test_cards: 'テストカード番号',
  business: '法人として購入する', tax_id_type: '税番号の種類', tax_id: '税番号', select: '選択…', optional: '(任意)',
  promotions: '{merchant}からのお知らせや特典を受け取る。', terms: '{merchant}の利用規約に同意します。',
  m_card: 'カード', m_bank: '米国の銀行口座', m_quartet: '4回払い', wallet: 'ウォレットで支払う', or_other: 'または他の方法で支払う',
  link_bank: '銀行を連携', manual_bank: '口座情報を手入力', routing: 'ルーティング番号', account_no: '口座番号', account_type: '口座種別', checking: '当座', savings: '普通',
  linked: '{bank} •••• {last4}', change: '変更', bank_name: '口座名義', instant_badge: '即時確認済み',
  mandate: 'お支払いにより、{merchant}が上記口座から{amount}を引き落とし、誤った引き落としを訂正することを承認します。この承認は{merchant}に連絡して取り消せます。',
  verify_title: '銀行口座の確認', verify_body: 'ご指定の口座に少額の入金を2回行いました（テストモードでは即時）。金額を入力してお支払いを完了してください。', verify_now: '口座を確認',
  quartet_line: '{amount}×4回（手数料無料）', quartet_note: 'Quartetに移動して支払いプランを承認します。', continue_quartet: 'Quartetへ進む',
  save_oneclick: 'ワンクリック決済用に情報を保存', save_oneclick_note: '次回からTessera加盟店でメールのコードだけで支払えます。',
  welcome_back: 'おかえりなさい。{email}に送信したコードを入力してください。', code: '確認コード', not_you: '別のアカウントですか？', signed_in: '{email}でサインイン中', use_other: '他の方法で支払う',
  code_hint: 'テストモード：000000が使えます。コードは開発者 → メールでも確認できます。', pay_saved: '{amount}を支払う', saved_cards: '保存済みカード', remove: '削除', expires: '有効期限 {date}',
  paid_title: 'お支払い完了', paid_body: 'ありがとうございます。{merchant}に{amount}をお支払いいただきました。', sub_title: '登録が完了しました', sub_body: '{item}に登録しました。領収書をお送りします。',
  setup_title: 'カードを保存しました', setup_body: '{merchant}は今後の購入でこのカードに請求できます。', continue: '続ける', redirecting: 'リダイレクト中…',
  processing_title: 'お支払い処理中', processing_body: '{amount}の口座振替が完了すると{merchant}から確認があります（通常4営業日以内）。',
  async_failed: '{merchant}への口座振替は完了しませんでした。{merchant}にお問い合わせください。',
  link_status: 'この支払いリンクは{status}です。', language: '言語', currency: '通貨', pay_in: '{currency}で支払う',
  converted: '1 {from} = {rate} {to}で換算（2%の換算手数料を含む）。銀行の手数料が別途かかる場合があります。', test_mode: 'テストモード',
  invoice_no: '請求書 {number}', due_on: '支払期日 {date}', download_pdf: '請求書PDFをダウンロード', amount_due: '請求額', remaining: '残額', paid_so_far: '支払済み', discount: '割引',
  schedule: '支払いスケジュール', installment: '第{n}回', paid_on: '{date}に支払済み', overdue: '期限超過', paid: '支払済み', pay_invoice: '請求書を支払う', invoice_paid: '支払済みの請求書',
  invoice_paid_body: '{merchant}に{amount}を支払いました。ありがとうございました。', invoice_status: 'この請求書は{status}です。', pay_next: '{what}を支払う：{amount}', next_installment: '次回分', pay_full: '残額{amount}をすべて支払う',
  reverse_charge_short: 'リバースチャージ：お客様がVATを申告します。',
};

const DICTS: Record<Lang, Dict> = { en, de, fr, es, ja };
export type Key = keyof Dict;

/** `auto` (or nothing) follows the browser; region tags (fr-FR) use their language. */
export function resolveLang(pref?: string | null): Lang {
  const pick = (l: string) => (l.slice(0, 2).toLowerCase() in DICTS ? (l.slice(0, 2).toLowerCase() as Lang) : null);
  if (pref && pref !== 'auto') return pick(pref) ?? 'en';
  for (const l of navigator.languages ?? [navigator.language]) { const x = pick(l); if (x) return x; }
  return 'en';
}

/** Intl locale used for numbers, money and dates on the page. */
export const intlLocale = (l: Lang) => ({ en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', ja: 'ja-JP' })[l];

export function translator(l: Lang) {
  const d = DICTS[l];
  // Names that end in a period ("Demo Coffee Co.") would otherwise produce "Co..".
  return (key: Key, vars: Record<string, string | number> = {}) => d[key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)).replace(/(\w)\.\.(?=\s|$)/g, '$1.');
}

/** A currency suggested for a language (adaptive pricing). */
export const SUGGESTED_CURRENCY: Record<Lang, string> = { en: 'usd', de: 'eur', fr: 'eur', es: 'eur', ja: 'jpy' };
