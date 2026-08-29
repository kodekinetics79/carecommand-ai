/**
 * What a patient must be told before RPM consent is recorded.
 *
 * Cost-sharing is the first-order reason the consent requirement exists: the
 * patient is agreeing to a billed service that involves no visit, and may owe a
 * copay. Showing the script on screen means the staff member is attesting to
 * language they actually conveyed, rather than the product asserting a consent
 * method nobody chose.
 *
 * Clinics should replace this with their own approved script.
 */
export const RPM_CONSENT_SCRIPT = [
  'You are being enrolled in a remote monitoring program. A device sends your readings to the clinic between visits.',
  'Your care team reviews these readings and may contact you about them. This is not an emergency service — in an emergency, call 911.',
  'This is a billed service. You may owe a copay or deductible amount, the same as any other Medicare Part B service.',
  'Only one practitioner can bill for this service in a period, and you can stop at any time by telling the clinic.',
];
