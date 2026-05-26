import type { Review } from '../types';

export const reviews: Review[] = [
  { id: 'rv1', patientName: 'Charlotte Davies', branchId: 'b1', doctorId: 'd1', rating: 5, text: 'Quick booking, friendly staff, and excellent follow-up after the visit.', platform: 'google', date: '2025-05-21', responded: true, aiDraftResponse: 'Thank you Charlotte! We appreciate your trust in CareCommand AI clinics.', sentiment: 'positive' },
  { id: 'rv2', patientName: 'Marcus Thompson', branchId: 'b1', doctorId: 'd2', rating: 3, text: 'Good care but waiting times were longer than expected after 5 PM.', platform: 'google', date: '2025-05-19', responded: false, sentiment: 'negative' },
  { id: 'rv3', patientName: 'Sophie Laurent', branchId: 'b3', doctorId: 'd9', rating: 5, text: 'My acne treatment plan was clear and the clinic was very professional.', platform: 'google', date: '2025-05-12', responded: true, aiDraftResponse: 'Thank you Sophie — we’re honoured to support your skin journey.', sentiment: 'positive' },
  { id: 'rv4', patientName: 'Yuki Tanaka', branchId: 'b4', doctorId: 'd7', rating: 2, text: "I didn't feel the treatment plan was explained enough, and follow-up communication was delayed.", platform: 'google', date: '2025-04-29', responded: false, sentiment: 'negative' },
  { id: 'rv5', patientName: 'Daniel Osei', branchId: 'b3', doctorId: 'd8', rating: 4, text: 'Great dental service with a calming environment.', platform: 'internal', date: '2025-05-16', responded: false, sentiment: 'positive' },
  { id: 'rv6', patientName: 'Amelia Foster', branchId: 'b1', doctorId: 'd3', rating: 5, text: 'The pediatric team made my daughter feel safe and understood.', platform: 'internal', date: '2025-05-18', responded: true, aiDraftResponse: 'Thank you for trusting our pediatric team, Amelia.', sentiment: 'positive' },
  { id: 'rv7', patientName: 'Harriet Cole', branchId: 'b1', doctorId: 'd1', rating: 4, text: 'Convenient clinic hours and helpful care coordinators.', platform: 'google', date: '2025-05-15', responded: false, sentiment: 'positive' },
  { id: 'rv8', patientName: 'Sara Haddad', branchId: 'b4', doctorId: 'd11', rating: 3, text: 'A solid experience but communication before the appointment could improve.', platform: 'google', date: '2025-05-10', responded: false, sentiment: 'neutral' },
];
