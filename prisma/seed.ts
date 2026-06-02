import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../server/generated/prisma/client';

const tenantId = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const userId = process.env.DEV_USER_ID ?? '22222222-2222-4222-8222-222222222222';
const branchId = '33333333-3333-4333-8333-333333333333';
const patientId = '44444444-4444-4444-8444-444444444444';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

await db.tenant.upsert({
  where: { id: tenantId },
  update: {},
  create: { id: tenantId, name: 'CareCommand Demo Clinics', slug: 'carecommand-demo' },
});

await db.branch.upsert({
  where: { id: branchId },
  update: {},
  create: { id: branchId, tenantId, name: 'Downtown Medical Centre', location: '42 Harley Street, London' },
});

await db.user.upsert({
  where: { id: userId },
  update: {},
  create: { id: userId, tenantId, email: 'owner@carecommand.local', displayName: 'Demo Owner', role: 'OWNER' },
});

for (const branch of [
  { id: branchId, name: 'Downtown Medical Centre', location: '42 Harley Street, London' },
  { id: '66666666-6666-4666-8666-666666666666', name: 'Northgate Wellness Studio', location: '18 Finchley Road, London' },
  { id: '77777777-7777-4777-8777-777777777777', name: 'Southbank Dental House', location: '7 Southbank Place, London' },
  { id: '88888888-8888-4888-8888-888888888888', name: 'Westside Family Clinic', location: '91 Uxbridge Road, London' },
]) {
  await db.branch.upsert({
    where: { id: branch.id },
    update: {},
    create: { id: branch.id, tenantId, name: branch.name, location: branch.location },
  });
}

const providerSeeds = [
  { email: 'sarah.mitchell@carecommand.local', displayName: 'Dr. Sarah Mitchell', branchId, specialty: 'Family Medicine', utilization: 92, appointmentsToday: 11, appointmentsThisMonth: 198, rating: 4.9, reviewCount: 142, revenueThisMonth: 38400, repeatVisitRate: 78, followUpRate: 88 },
  { email: 'james.okafor@carecommand.local', displayName: 'Dr. James Okafor', branchId, specialty: 'Dermatology', utilization: 88, appointmentsToday: 10, appointmentsThisMonth: 172, rating: 4.8, reviewCount: 98, revenueThisMonth: 44200, repeatVisitRate: 71, followUpRate: 82 },
  { email: 'priya.sharma@carecommand.local', displayName: 'Dr. Priya Sharma', branchId, specialty: 'Pediatrics', utilization: 84, appointmentsToday: 9, appointmentsThisMonth: 160, rating: 4.9, reviewCount: 201, revenueThisMonth: 28900, repeatVisitRate: 85, followUpRate: 91 },
  { email: 'ahmed.hassan@carecommand.local', displayName: 'Dr. Ahmed Hassan', branchId, specialty: 'Internal Medicine', utilization: 79, appointmentsToday: 8, appointmentsThisMonth: 144, rating: 4.7, reviewCount: 67, revenueThisMonth: 31200, repeatVisitRate: 68, followUpRate: 76 },
  { email: 'emma.clarke@carecommand.local', displayName: 'Dr. Emma Clarke', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Family Medicine', utilization: 65, appointmentsToday: 8, appointmentsThisMonth: 128, rating: 4.6, reviewCount: 54, revenueThisMonth: 24100, repeatVisitRate: 62, followUpRate: 71 },
  { email: 'raj.patel@carecommand.local', displayName: 'Dr. Raj Patel', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Physiotherapy', utilization: 58, appointmentsToday: 9, appointmentsThisMonth: 112, rating: 4.7, reviewCount: 89, revenueThisMonth: 19800, repeatVisitRate: 74, followUpRate: 84 },
  { email: 'lisa.wong@carecommand.local', displayName: 'Dr. Lisa Wong', branchId: '66666666-6666-4666-8666-666666666666', specialty: 'Wellness & Nutrition', utilization: 61, appointmentsToday: 7, appointmentsThisMonth: 98, rating: 4.8, reviewCount: 43, revenueThisMonth: 21300, repeatVisitRate: 69, followUpRate: 79 },
  { email: 'marcus.bell@carecommand.local', displayName: 'Dr. Marcus Bell', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dental', utilization: 81, appointmentsToday: 12, appointmentsThisMonth: 210, rating: 4.8, reviewCount: 176, revenueThisMonth: 52100, repeatVisitRate: 76, followUpRate: 87 },
  { email: 'aisha.nwosu@carecommand.local', displayName: 'Dr. Aisha Nwosu', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dermatology', utilization: 76, appointmentsToday: 10, appointmentsThisMonth: 158, rating: 4.9, reviewCount: 121, revenueThisMonth: 41400, repeatVisitRate: 82, followUpRate: 90 },
  { email: 'tom.eriksson@carecommand.local', displayName: 'Dr. Tom Eriksson', branchId: '77777777-7777-4777-8777-777777777777', specialty: 'Dental', utilization: 68, appointmentsToday: 7, appointmentsThisMonth: 132, rating: 4.6, reviewCount: 88, revenueThisMonth: 34200, repeatVisitRate: 65, followUpRate: 73 },
  { email: 'fatima.alrashid@carecommand.local', displayName: 'Dr. Fatima Al-Rashid', branchId: '88888888-8888-4888-8888-888888888888', specialty: 'Family Medicine', utilization: 55, appointmentsToday: 10, appointmentsThisMonth: 104, rating: 4.7, reviewCount: 39, revenueThisMonth: 22800, repeatVisitRate: 58, followUpRate: 68 },
  { email: 'nathan.brooks@carecommand.local', displayName: 'Dr. Nathan Brooks', branchId: '88888888-8888-4888-8888-888888888888', specialty: 'Physiotherapy', utilization: 49, appointmentsToday: 7, appointmentsThisMonth: 88, rating: 4.5, reviewCount: 28, revenueThisMonth: 16400, repeatVisitRate: 52, followUpRate: 62 },
] as const;

for (const provider of providerSeeds) {
  const user = await db.user.findFirst({
    where: {
      tenantId,
      email: provider.email,
    },
  });
  const providerUser = user ?? await db.user.create({
    data: {
      tenantId,
      branchId: provider.branchId,
      email: provider.email,
      displayName: provider.displayName,
      role: 'PROVIDER',
    },
  });

  const existingProfile = await db.providerProfile.findFirst({
    where: {
      tenantId,
      userId: providerUser.id,
    },
  });
  if (!existingProfile) {
    await db.providerProfile.create({
      data: {
        tenantId,
        branchId: provider.branchId,
        userId: providerUser.id,
        specialty: provider.specialty,
        utilization: provider.utilization,
        appointmentsToday: provider.appointmentsToday,
        appointmentsThisMonth: provider.appointmentsThisMonth,
        rating: provider.rating,
        reviewCount: provider.reviewCount,
        revenueThisMonth: provider.revenueThisMonth,
        repeatVisitRate: provider.repeatVisitRate,
        followUpRate: provider.followUpRate,
      },
    });
  }
}

const staffSeeds = [
  { email: 'tanya.obi@carecommand.local', name: 'Tanya Obi', roleTitle: 'Senior Receptionist', branchId, responseTime: 3.8, missedCalls: 4, followUpRate: 88, bookingConversionRate: 72, tasksCompleted: 42, tasksPending: 5, patientFeedbackScore: 4.7 },
  { email: 'aaron.mensah@carecommand.local', name: 'Aaron Mensah', roleTitle: 'Receptionist', branchId, responseTime: 5.2, missedCalls: 9, followUpRate: 74, bookingConversionRate: 61, tasksCompleted: 31, tasksPending: 8, patientFeedbackScore: 4.3 },
  { email: 'blessing.eze@carecommand.local', name: 'Blessing Eze', roleTitle: 'Care Coordinator', branchId, responseTime: 4.1, missedCalls: 2, followUpRate: 94, bookingConversionRate: 81, tasksCompleted: 58, tasksPending: 3, patientFeedbackScore: 4.9 },
  { email: 'jake.williams@carecommand.local', name: 'Jake Williams', roleTitle: 'Receptionist', branchId: '66666666-6666-4666-8666-666666666666', responseTime: 6.7, missedCalls: 14, followUpRate: 58, bookingConversionRate: 49, tasksCompleted: 24, tasksPending: 12, patientFeedbackScore: 3.9 },
  { email: 'nia.asante@carecommand.local', name: 'Nia Asante', roleTitle: 'Senior Receptionist', branchId: '66666666-6666-4666-8666-666666666666', responseTime: 4.9, missedCalls: 6, followUpRate: 79, bookingConversionRate: 66, tasksCompleted: 38, tasksPending: 6, patientFeedbackScore: 4.5 },
  { email: 'mia.larsson@carecommand.local', name: 'Mia Larsson', roleTitle: 'Receptionist', branchId: '77777777-7777-4777-8777-777777777777', responseTime: 3.2, missedCalls: 3, followUpRate: 91, bookingConversionRate: 78, tasksCompleted: 47, tasksPending: 2, patientFeedbackScore: 4.8 },
  { email: 'leo.adeyemi@carecommand.local', name: 'Leo Adeyemi', roleTitle: 'Care Coordinator', branchId: '77777777-7777-4777-8777-777777777777', responseTime: 4.4, missedCalls: 5, followUpRate: 86, bookingConversionRate: 73, tasksCompleted: 52, tasksPending: 4, patientFeedbackScore: 4.6 },
  { email: 'sara.haddad@carecommand.local', name: 'Sara Haddad', roleTitle: 'Receptionist', branchId: '88888888-8888-4888-8888-888888888888', responseTime: 8.1, missedCalls: 18, followUpRate: 44, bookingConversionRate: 38, tasksCompleted: 18, tasksPending: 16, patientFeedbackScore: 3.6 },
  { email: 'chris.nwosu@carecommand.local', name: 'Chris Nwosu', roleTitle: 'Receptionist', branchId: '88888888-8888-4888-8888-888888888888', responseTime: 7.4, missedCalls: 12, followUpRate: 51, bookingConversionRate: 42, tasksCompleted: 22, tasksPending: 11, patientFeedbackScore: 3.8 },
  { email: 'karen.bloom@carecommand.local', name: 'Karen Bloom', roleTitle: 'Practice Manager', branchId, responseTime: 2.9, missedCalls: 1, followUpRate: 97, bookingConversionRate: 88, tasksCompleted: 64, tasksPending: 2, patientFeedbackScore: 4.9 },
] as const;

const staffUsers: Record<string, string> = {};
for (const staff of staffSeeds) {
  const user = await db.user.upsert({
    where: { tenantId_email: { tenantId, email: staff.email } },
    update: { displayName: staff.name, role: staff.roleTitle === 'Practice Manager' ? 'MANAGER' : 'FRONT_DESK', branchId: staff.branchId },
    create: {
      tenantId,
      branchId: staff.branchId,
      email: staff.email,
      displayName: staff.name,
      role: staff.roleTitle === 'Practice Manager' ? 'MANAGER' : 'FRONT_DESK',
    },
  });
  staffUsers[staff.email] = user.id;

  const existingProfile = await db.staffProfile.findFirst({ where: { tenantId, userId: user.id } });
  if (!existingProfile) {
    await db.staffProfile.create({
      data: {
        tenantId,
        branchId: staff.branchId,
        userId: user.id,
        roleTitle: staff.roleTitle,
        responseTime: staff.responseTime,
        missedCalls: staff.missedCalls,
        followUpRate: staff.followUpRate,
        bookingConversionRate: staff.bookingConversionRate,
        tasksCompleted: staff.tasksCompleted,
        tasksPending: staff.tasksPending,
        patientFeedbackScore: staff.patientFeedbackScore,
      },
    });
  }
}

await db.patient.upsert({
  where: { id: patientId },
  update: {},
  create: {
    id: patientId,
    tenantId,
    branchId,
    firstName: 'Charlotte',
    lastName: 'Live',
    email: 'charlotte.live@carecommand.local',
    phone: '+44 7700 900100',
    lifecycleStage: 'ACTIVE',
    churnRisk: 12,
    lifetimeValue: 4250,
    tags: ['live-db', 'wellness'],
  },
});

for (const consent of [
  { purpose: 'EMAIL' as const, granted: true },
  { purpose: 'MARKETING' as const, granted: true },
]) {
  const existing = await db.consentEvent.findFirst({ where: { tenantId, patientId, purpose: consent.purpose } });
  if (!existing) await db.consentEvent.create({ data: { tenantId, patientId, source: 'seed', ...consent } });
}

const appointment = await db.appointment.findFirst({ where: { tenantId, patientId, service: 'Live Wellness Review' } });
if (!appointment) {
  await db.appointment.create({
    data: {
      tenantId, branchId, patientId, service: 'Live Wellness Review',
      startsAt: new Date('2026-06-03T09:00:00Z'), endsAt: new Date('2026-06-03T09:30:00Z'),
      channel: 'EMAIL', value: 180, noShowRisk: 12,
    },
  });
}

// Virtual visits (VIDEO channel) power the Telehealth module.
const virtualVisits = [
  { service: 'Virtual Dermatology Review', startsAt: '2026-06-03T10:00:00Z', endsAt: '2026-06-03T10:30:00Z', status: 'CONFIRMED' as const, value: 220, noShowRisk: 6, providerRef: 'Dr. Priya Sharma' },
  { service: 'Telehealth Nutrition Follow-up', startsAt: '2026-06-03T13:00:00Z', endsAt: '2026-06-03T13:30:00Z', status: 'WAITLIST' as const, value: 180, noShowRisk: 38, providerRef: 'Dr. Lisa Wong' },
];
for (const visit of virtualVisits) {
  const existing = await db.appointment.findFirst({ where: { tenantId, patientId, service: visit.service } });
  if (!existing) {
    await db.appointment.create({
      data: {
        tenantId, branchId, patientId, service: visit.service,
        startsAt: new Date(visit.startsAt), endsAt: new Date(visit.endsAt),
        status: visit.status, channel: 'VIDEO', value: visit.value, noShowRisk: visit.noShowRisk, providerRef: visit.providerRef,
      },
    });
  }
}

await db.integration.upsert({
  where: { tenantId_key: { tenantId, key: 'whatsapp-business' } },
  update: {},
  create: {
    tenantId, key: 'whatsapp-business', name: 'WhatsApp Business', category: 'Messaging', status: 'CONNECTED',
    config: { icon: 'MessagesSquare', description: 'Live two-way messaging and consent-aware appointment follow-up.' },
    lastSyncAt: new Date(),
  },
});

const review = await db.review.findFirst({ where: { tenantId, patientId, text: 'Live database review: smooth booking and thoughtful follow-up.' } });
if (!review) await db.review.create({ data: { tenantId, branchId, patientId, rating: 5, text: 'Live database review: smooth booking and thoughtful follow-up.', platform: 'google', sentiment: 'positive' } });

const report = await db.partnerReport.findFirst({ where: { tenantId, patientId, reportType: 'Live partner wellness report' } });
if (!report) await db.partnerReport.create({ data: { tenantId, branchId, patientId, reportType: 'Live partner wellness report', partner: 'TDL London', urgency: 'routine', status: 'result-received', summary: 'Live operational document ready for provider review.', reviewedAt: new Date('2026-06-02T10:20:00Z'), reviewedByUserId: userId } });

const task = await db.staffTask.findFirst({ where: { tenantId, title: 'Live DB: confirm wellness follow-up' } });
if (!task) await db.staffTask.create({ data: { tenantId, branchId, assignedToId: userId, title: 'Live DB: confirm wellness follow-up', priority: 'medium', dueAt: new Date('2026-06-01T12:00:00Z') } });

for (const seededTask of [
  { title: 'Follow up: Marcus Thompson (missed call)', branchId, priority: 'high', dueAt: new Date('2026-06-02T10:00:00Z'), assignedToEmail: 'aaron.mensah@carecommand.local', status: 'OPEN' },
  { title: 'Send reactivation message to Yuki Tanaka', branchId: '66666666-6666-4666-8666-666666666666', priority: 'high', dueAt: new Date('2026-06-02T15:00:00Z'), assignedToEmail: 'sara.haddad@carecommand.local', status: 'OPEN' },
  { title: 'Confirm Botox reorder with Allergan UK', branchId, priority: 'medium', dueAt: new Date('2026-06-02T17:00:00Z'), assignedToEmail: 'karen.bloom@carecommand.local', status: 'IN_PROGRESS' },
  { title: 'Review Dr. Mitchell appointment schedule gaps', branchId, priority: 'medium', dueAt: new Date('2026-06-03T10:00:00Z'), assignedToEmail: 'tanya.obi@carecommand.local', status: 'OPEN' },
  { title: 'Send post-visit review request to Sophie Laurent', branchId: '77777777-7777-4777-8777-777777777777', priority: 'low', dueAt: new Date('2026-06-03T11:00:00Z'), assignedToEmail: 'mia.larsson@carecommand.local', status: 'COMPLETED' },
  { title: 'Assign 14 follow-up customers to coordinators', branchId, priority: 'high', dueAt: new Date('2026-06-02T08:00:00Z'), assignedToEmail: 'blessing.eze@carecommand.local', status: 'OPEN' },
]) {
  const existingTask = await db.staffTask.findFirst({ where: { tenantId, title: seededTask.title } });
  if (!existingTask) {
    await db.staffTask.create({
      data: {
        tenantId,
        branchId: seededTask.branchId,
        assignedToId: staffUsers[seededTask.assignedToEmail] ?? userId,
        title: seededTask.title,
        priority: seededTask.priority,
        dueAt: seededTask.dueAt,
        status: seededTask.status as 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED',
      },
    });
  }
}

const snapshot = await db.revenueSnapshot.findFirst({ where: { tenantId, branchId: null, period: new Date('2026-06-01T00:00:00Z') } });
if (!snapshot) await db.revenueSnapshot.create({ data: { tenantId, period: new Date('2026-06-01T00:00:00Z'), revenue: 332000, recovered: 28600, lost: 24100, campaigns: 18200 } });

const conversation = await db.conversation.findFirst({ where: { tenantId, patientId, latestMessage: 'Live DB enquiry: can I book a wellness review this week?' } });
if (!conversation) await db.conversation.create({
  data: {
    tenantId,
    branchId,
    patientId,
    channel: 'WHATSAPP',
    status: 'unread',
    intent: 'Booking inquiry',
    latestMessage: 'Live DB enquiry: can I book a wellness review this week?',
    lastAgentMessage: 'Absolutely — we have openings on Thursday and Friday this week.',
    lastAgentMessageAt: new Date('2026-06-02T09:40:00Z'),
    estimatedValue: 180,
    aiHandled: true,
  },
});

for (const seededConversation of [
  {
    branchId,
    patientId,
    channel: 'CALL',
    status: 'ai-recovered',
    intent: 'Missed call recovery',
    latestMessage: 'Missed call from front desk at 08:42 — follow-up sent by AI.',
    lastAgentMessage: 'Sorry we missed you. Reply with a good time and we will reserve a slot.',
    lastAgentMessageAt: new Date('2026-06-02T08:50:00Z'),
    estimatedValue: 420,
    aiHandled: true,
  },
  {
    branchId,
    patientId,
    channel: 'SMS',
    status: 'replied',
    intent: 'Reschedule request',
    latestMessage: 'Can I move my treatment to later this week?',
    lastAgentMessage: 'Of course — I can move it to Friday at 11:00 if that works for you.',
    lastAgentMessageAt: new Date('2026-06-02T11:12:00Z'),
    estimatedValue: 260,
    aiHandled: true,
  },
  {
    branchId,
    patientId,
    channel: 'EMAIL',
    status: 'escalated',
    intent: 'Pricing escalation',
    latestMessage: 'I need a manager to review my package pricing.',
    lastAgentMessage: 'I have escalated this to the practice manager for a same-day review.',
    lastAgentMessageAt: new Date('2026-06-02T12:25:00Z'),
    estimatedValue: 580,
    aiHandled: false,
  },
]) {
  const existingConversation = await db.conversation.findFirst({
    where: {
      tenantId,
      channel: seededConversation.channel as 'CALL' | 'SMS' | 'EMAIL',
      intent: seededConversation.intent,
      latestMessage: seededConversation.latestMessage,
    },
  });
  if (!existingConversation) {
    await db.conversation.create({
      data: {
        tenantId,
        branchId: seededConversation.branchId,
        patientId: seededConversation.patientId,
        channel: seededConversation.channel as 'CALL' | 'SMS' | 'EMAIL',
        status: seededConversation.status,
        intent: seededConversation.intent,
        latestMessage: seededConversation.latestMessage,
        lastAgentMessage: seededConversation.lastAgentMessage,
        lastAgentMessageAt: seededConversation.lastAgentMessageAt,
        estimatedValue: seededConversation.estimatedValue,
        aiHandled: seededConversation.aiHandled,
      },
    });
  }
}

for (const competitor of [
  {
    name: 'Apex MediSuite Dental',
    distanceKm: 1.4,
    googleRating: 4.6,
    reviewVolume: 286,
    complaintThemes: ['long waits', 'hard upsell', 'weak follow-up'],
    activeOffers: ['Free consultation', '0% finance'],
    localRankTrend: 'down',
    weaknessSummary: 'Lower review velocity and inconsistent post-visit follow-up.',
    opportunityAlert: 'Rating gap opened up after recent complaint spikes.',
    marketOpeningRecommendation: 'Run a fast-response reputation and reactivation campaign.',
  },
  {
    name: 'Northgate Wellness Studio',
    distanceKm: 2.8,
    googleRating: 4.2,
    reviewVolume: 92,
    complaintThemes: ['pricing', 'availability'],
    activeOffers: ['Weekend bundle'],
    localRankTrend: 'flat',
    weaknessSummary: 'Weak local visibility and limited review momentum.',
    opportunityAlert: 'Their bundled offer is attracting price-sensitive leads.',
    marketOpeningRecommendation: 'Target value-led campaigns with clear booking urgency.',
  },
  {
    name: 'PrimeCare Clinic Group',
    distanceKm: 3.1,
    googleRating: 4.8,
    reviewVolume: 514,
    complaintThemes: ['wait times', 'phone delays'],
    activeOffers: ['Same-day booking'],
    localRankTrend: 'up',
    weaknessSummary: 'Strong reputation but slow call handling creates openings.',
    opportunityAlert: 'Phone delays are the most exploitable gap in the market.',
    marketOpeningRecommendation: 'Compete on response speed and missed-call recovery.',
  },
]) {
  const existingCompetitor = await db.competitor.findFirst({ where: { tenantId, name: competitor.name } });
  const competitorRow = existingCompetitor ?? await db.competitor.create({
    data: { tenantId, branchId, ...competitor },
  });
  const insightThemes = [
    { theme: 'waiting time', complaintCount: 14, summary: 'Patients often mention slow handoff from reception to consult.' },
    { theme: 'price transparency', complaintCount: 9, summary: 'Prospects are comparing pricing before booking.' },
  ];
  for (const insight of insightThemes) {
    const existingInsight = await db.competitorReviewInsight.findFirst({ where: { tenantId, competitorId: competitorRow.id, theme: insight.theme } });
    if (!existingInsight) {
      await db.competitorReviewInsight.create({ data: { tenantId, competitorId: competitorRow.id, ...insight } });
    }
  }
}

for (const reputationCase of [
  {
    complaintCategory: 'waiting-times',
    unresolvedComplaint: 'Patient experienced a 35-minute delay after a 5pm booking.',
    workflowStatus: 'needs-message',
    recoveryWorkflow: 'Send apology, explain cause, and offer priority rebooking.',
    suggestedReply: 'We are sorry for the delay. We value your time and would like to make this right.',
    badReviewRisk: 82,
    npsScore: 38,
    publicTrend: 'down',
    staffComplaintDetected: true,
  },
  {
    complaintCategory: 'communication-gap',
    unresolvedComplaint: 'Follow-up instructions were not received after the visit.',
    workflowStatus: 'in-review',
    recoveryWorkflow: 'Escalate to coordinator and resend instructions with follow-up task.',
    suggestedReply: 'Thank you for raising this. We are reviewing the follow-up process immediately.',
    badReviewRisk: 71,
    npsScore: 46,
    publicTrend: 'flat',
    staffComplaintDetected: false,
  },
  {
    complaintCategory: 'billing',
    unresolvedComplaint: 'Invoice clarification requested after the automated payment reminder.',
    workflowStatus: 'resolved',
    recoveryWorkflow: 'Confirm outstanding balance and close loop with a direct call.',
    suggestedReply: 'Thanks for flagging this. We have clarified the invoice and updated the account.',
    badReviewRisk: 54,
    npsScore: 58,
    publicTrend: 'up',
    staffComplaintDetected: false,
  },
]) {
  const existingCase = await db.reputationCase.findFirst({ where: { tenantId, complaintCategory: reputationCase.complaintCategory, unresolvedComplaint: reputationCase.unresolvedComplaint } });
  if (!existingCase) {
    await db.reputationCase.create({
      data: {
        tenantId,
        branchId,
        patientId: reputationCase.complaintCategory === 'waiting-times' ? patientId : undefined,
        ...reputationCase,
      },
    });
  }
}

for (const request of [
  {
    channel: 'WHATSAPP' as const,
    requestType: 'post-visit review request',
    status: 'SENT',
    message: 'Thanks for visiting. Would you leave a quick Google review about your experience?',
    sentAt: new Date('2026-06-01T15:00:00Z'),
    ratingReceived: 5,
  },
  {
    channel: 'SMS' as const,
    requestType: 'recovery-message',
    status: 'DELIVERED',
    message: 'We noticed a delay in your visit and wanted to follow up personally.',
    sentAt: new Date('2026-06-01T13:45:00Z'),
  },
  {
    channel: 'EMAIL' as const,
    requestType: 'family referral review',
    status: 'OPENED',
    message: 'Share your feedback and help your family know what to expect.',
    sentAt: new Date('2026-05-31T10:15:00Z'),
  },
]) {
  const existingRequest = await db.reviewRequest.findFirst({ where: { tenantId, requestType: request.requestType, message: request.message } });
  if (!existingRequest) {
    await db.reviewRequest.create({
      data: {
        tenantId,
        branchId,
        patientId,
        ...request,
      },
    });
  }
}

const ownerLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Missed call queue', evidence: '23 inbound calls missed before follow-up' } });
if (!ownerLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      patientId,
      ownerUserId: userId,
      category: 'missed-calls',
      source: 'Missed call queue',
      evidence: '23 inbound calls missed before follow-up',
      estimatedValue: 3450,
      confidence: 91,
      status: 'open',
      workflowStatus: 'needs-action',
      suggestedAction: 'Launch a 5-minute callback playbook and assign a recovery task to the front desk.',
    },
  });
}

const slotLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Open slot analysis', evidence: '31 empty slots detected on the Westside schedule' } });
if (!slotLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      category: 'unfilled-slots',
      source: 'Open slot analysis',
      evidence: '31 empty slots detected on the Westside schedule',
      estimatedValue: 6200,
      confidence: 87,
      status: 'open',
      workflowStatus: 'queued',
      suggestedAction: 'Run a weekday fill campaign with a limited-time offer and SMS follow-up.',
    },
  });
}

const inactiveLeak = await db.revenueLeak.findFirst({ where: { tenantId, source: 'Reactivation gap', evidence: '187 inactive patients have not been contacted in 90 days' } });
if (!inactiveLeak) {
  await db.revenueLeak.create({
    data: {
      tenantId,
      branchId,
      category: 'inactive-patients',
      source: 'Reactivation gap',
      evidence: '187 inactive patients have not been contacted in 90 days',
      estimatedValue: 18700,
      confidence: 83,
      status: 'open',
      workflowStatus: 'reviewed',
      suggestedAction: 'Trigger a winback sequence for high-value inactive patients with approval guardrails.',
    },
  });
}

for (const opportunity of [
  {
    title: 'Win back inactive patients',
    source: 'Customer reactivation model',
    category: 'reactivation',
    trigger: '90-day inactivity cohort',
    expectedRevenue: 18700,
    actualRevenue: 0,
    roi: 8.4,
    confidence: 86,
    effortLevel: 'medium',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Approve the inactive-patient campaign and dispatch SMS + email recovery.',
  },
  {
    title: 'Fill weekday gaps',
    source: 'Schedule capacity analysis',
    category: 'slot-fill',
    trigger: '31 open slots on Westside',
    expectedRevenue: 6200,
    actualRevenue: 0,
    roi: 5.7,
    confidence: 89,
    effortLevel: 'low',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Launch a short-notice promotion and offer online booking incentives.',
  },
  {
    title: 'Recover missed-call inquiries',
    source: 'Front desk call log',
    category: 'front-desk',
    trigger: 'Missed-call queue above threshold',
    expectedRevenue: 3450,
    actualRevenue: 780,
    roi: 6.2,
    confidence: 92,
    effortLevel: 'low',
    urgency: 'medium',
    status: 'running',
    ownerApprovalRequired: false,
    recommendedAction: 'Keep the callback workflow active and escalate unbooked callers after 10 minutes.',
  },
]) {
  const existingOpportunity = await db.opportunity.findFirst({ where: { tenantId, title: opportunity.title } });
  if (!existingOpportunity) {
    await db.opportunity.create({
      data: {
        tenantId,
        branchId,
        ownerUserId: userId,
        patientId: opportunity.title.includes('inactive') ? patientId : undefined,
        automationSteps: {
          trigger: opportunity.trigger,
          steps: ['detect', 'verify consent', 'queue action', 'measure outcome'],
        },
        ...opportunity,
      },
    });
  }
}

for (const playbook of [
  { key: 'empty-slot-rescue', name: 'Empty Slot Rescue', description: 'Match released capacity with consent-safe customer outreach.' },
  { key: 'missed-call-recovery', name: 'Missed Call Recovery', description: 'Recover missed inquiries with channel-aware follow-up.' },
  { key: 'customer-winback', name: 'Customer Winback', description: 'Escalate or automate reactivation based on customer value.' },
]) {
  await db.autopilotPlaybook.upsert({
    where: { tenantId_key: { tenantId, key: playbook.key } },
    update: {},
    create: { tenantId, ...playbook, status: 'LIVE', config: { autonomyLevel: 2 } },
  });
}

const slotFillPlaybook = await db.autopilotPlaybook.findUniqueOrThrow({
  where: { tenantId_key: { tenantId, key: 'empty-slot-rescue' } },
});

const pendingApproval = await db.autopilotApproval.findFirst({
  where: { tenantId, title: 'Activate Westside weekday slot-fill offer', status: 'PENDING' },
});

if (!pendingApproval) {
  await db.autopilotApproval.create({
    data: {
      tenantId,
      playbookId: slotFillPlaybook.id,
      title: 'Activate Westside weekday slot-fill offer',
      reason: '31 empty slots detected · estimated £6,200 at risk',
      payload: { scope: 'Send to 84 matched customers', value: '£6,200' },
      confidence: 91,
    },
  });
}

// ---- Configuration management defaults --------------------------------------
if (await db.notificationTemplate.count({ where: { tenantId } }) === 0) {
  await db.notificationTemplate.createMany({
    data: [
      { tenantId, name: 'Appointment reminder (24h)', channel: 'WhatsApp + SMS', status: 'ACTIVE' },
      { tenantId, name: 'Post-visit review request', channel: 'WhatsApp', status: 'ACTIVE' },
      { tenantId, name: 'Missed call follow-up', channel: 'SMS', status: 'ACTIVE' },
      { tenantId, name: 'Reactivation campaign (90d inactive)', channel: 'WhatsApp + Email', status: 'ACTIVE' },
      { tenantId, name: 'Winback offer (180d inactive)', channel: 'Email', status: 'PAUSED' },
    ],
  });
}

if (await db.aiGuardrail.count({ where: { tenantId } }) === 0) {
  await db.aiGuardrail.createMany({
    data: [
      { tenantId, rule: 'No clinical diagnosis or medical advice generated', sortOrder: 0 },
      { tenantId, rule: 'Clinical questions routed to provider, not answered automatically', sortOrder: 1 },
      { tenantId, rule: 'Marketing messages sent only to opted-in customers', sortOrder: 2 },
      { tenantId, rule: 'Role-based access: front desk cannot view financial records', sortOrder: 3 },
      { tenantId, rule: 'All AI-generated content reviewed before sending', sortOrder: 4 },
      { tenantId, rule: 'Data retained per GDPR 6-year retention policy', sortOrder: 5 },
    ],
  });
}

if (await db.customerPreference.count({ where: { tenantId } }) === 0) {
  await db.customerPreference.createMany({
    data: [
      { tenantId, label: 'Appointment reminders', description: 'Auto-sent via preferred channel', enabled: true, sortOrder: 0 },
      { tenantId, label: 'Promotional campaigns', description: 'Only for opted-in customers', enabled: true, sortOrder: 1 },
      { tenantId, label: 'Post-visit review requests', description: '24h after appointment', enabled: true, sortOrder: 2 },
      { tenantId, label: 'Winback & reactivation', description: 'Marketing consent required', enabled: true, sortOrder: 3 },
    ],
  });
}

for (const role of [
  { name: 'Owner', description: 'Full access to all modules, billing, and settings.', accent: 'violet', sortOrder: 0 },
  { name: 'Branch Manager', description: 'Access to branch-level data, staff, and inventory.', accent: 'blue', sortOrder: 1 },
  { name: 'Provider', description: 'Own schedule, patient notes, and follow-up tools.', accent: 'emerald', sortOrder: 2 },
  { name: 'Front Desk', description: 'Scheduling, CRM, and inbound communication.', accent: 'amber', sortOrder: 3 },
]) {
  await db.roleDefinition.upsert({
    where: { tenantId_name: { tenantId, name: role.name } },
    update: { description: role.description, accent: role.accent, sortOrder: role.sortOrder },
    create: { tenantId, ...role },
  });
}

await db.$disconnect();
