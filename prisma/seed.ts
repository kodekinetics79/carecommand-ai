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

// ---- Demo population: customers, schedule, pipeline, stock, revenue ---------
const DAY = 86_400_000;
const NOW = Date.now();
const BR = {
  downtown: branchId,
  northgate: '66666666-6666-4666-8666-666666666666',
  southbank: '77777777-7777-4777-8777-777777777777',
  westside: '88888888-8888-4888-8888-888888888888',
};

const extraPatients = [
  { ref: 'p-amelia', firstName: 'Amelia', lastName: 'Hughes', branchId: BR.downtown, lifecycleStage: 'ACTIVE', churnRisk: 14, lifetimeValue: 5200, outstandingBalance: 0, tags: ['vip', 'skincare'], last: -9, next: 6, consents: ['WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-daniel', firstName: 'Daniel', lastName: 'Okoro', branchId: BR.downtown, lifecycleStage: 'AT_RISK', churnRisk: 67, lifetimeValue: 2840, outstandingBalance: 120, tags: ['follow-up'], last: -58, next: null, consents: ['SMS', 'EMAIL'] },
  { ref: 'p-sofia', firstName: 'Sofia', lastName: 'Marchetti', branchId: BR.northgate, lifecycleStage: 'NEW', churnRisk: 8, lifetimeValue: 320, outstandingBalance: 0, tags: ['new-lead'], last: -2, next: 11, consents: ['WHATSAPP'] },
  { ref: 'p-james', firstName: 'James', lastName: 'Whitfield', branchId: BR.southbank, lifecycleStage: 'ACTIVE', churnRisk: 22, lifetimeValue: 7650, outstandingBalance: 0, tags: ['dental', 'vip'], last: -16, next: 3, consents: ['SMS', 'WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-yuki', firstName: 'Yuki', lastName: 'Tanaka', branchId: BR.northgate, lifecycleStage: 'INACTIVE', churnRisk: 81, lifetimeValue: 1980, outstandingBalance: 0, tags: ['winback'], last: -124, next: null, consents: ['EMAIL'] },
  { ref: 'p-grace', firstName: 'Grace', lastName: 'Adeyemi', branchId: BR.downtown, lifecycleStage: 'RETAINED', churnRisk: 11, lifetimeValue: 9320, outstandingBalance: 0, tags: ['vip', 'referrer'], last: -5, next: 19, consents: ['WHATSAPP', 'SMS', 'EMAIL', 'MARKETING'] },
  { ref: 'p-tom', firstName: 'Tom', lastName: 'Nakamura', branchId: BR.westside, lifecycleStage: 'LOST', churnRisk: 94, lifetimeValue: 640, outstandingBalance: 0, tags: ['opted-out'], last: -210, next: null, consents: [] },
  { ref: 'p-sophie', firstName: 'Sophie', lastName: 'Laurent', branchId: BR.southbank, lifecycleStage: 'ACTIVE', churnRisk: 19, lifetimeValue: 4410, outstandingBalance: 260, tags: ['dental'], last: -7, next: 9, consents: ['WHATSAPP', 'EMAIL'] },
  { ref: 'p-marcus', firstName: 'Marcus', lastName: 'Thompson', branchId: BR.downtown, lifecycleStage: 'AT_RISK', churnRisk: 58, lifetimeValue: 3120, outstandingBalance: 0, tags: ['missed-call'], last: -41, next: null, consents: ['SMS'] },
  { ref: 'p-elena', firstName: 'Elena', lastName: 'Petrova', branchId: BR.northgate, lifecycleStage: 'ACTIVE', churnRisk: 27, lifetimeValue: 5870, outstandingBalance: 0, tags: ['nutrition'], last: -11, next: 14, consents: ['WHATSAPP', 'EMAIL', 'MARKETING'] },
  { ref: 'p-omar', firstName: 'Omar', lastName: 'Farouk', branchId: BR.westside, lifecycleStage: 'NEW', churnRisk: 6, lifetimeValue: 180, outstandingBalance: 0, tags: ['new-lead'], last: -1, next: 5, consents: ['SMS', 'WHATSAPP'] },
] as const;

const patientPool: { id: string; branchId: string; name: string }[] = [
  { id: patientId, branchId, name: 'Charlotte Live' },
];
for (const p of extraPatients) {
  const row = await db.patient.upsert({
    where: { tenantId_externalRef: { tenantId, externalRef: p.ref } },
    update: {},
    create: {
      tenantId, branchId: p.branchId, externalRef: p.ref,
      firstName: p.firstName, lastName: p.lastName,
      email: `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase()}@example.com`,
      phone: `+44 7700 9${String(Math.abs(p.churnRisk * 137) % 100000).padStart(5, '0')}`,
      lifecycleStage: p.lifecycleStage, churnRisk: p.churnRisk, lifetimeValue: p.lifetimeValue,
      outstandingBalance: p.outstandingBalance, tags: [...p.tags],
      lastVisitAt: p.last != null ? new Date(NOW + p.last * DAY) : null,
      nextVisitAt: p.next != null ? new Date(NOW + p.next * DAY) : null,
    },
  });
  patientPool.push({ id: row.id, branchId: p.branchId, name: `${p.firstName} ${p.lastName}` });
  for (const purpose of p.consents) {
    const existing = await db.consentEvent.findFirst({ where: { tenantId, patientId: row.id, purpose } });
    if (!existing) await db.consentEvent.create({ data: { tenantId, patientId: row.id, purpose, granted: true, source: 'seed' } });
  }
}

if (await db.appointment.count({ where: { tenantId } }) < 6) {
  const services = ['Botox Consultation', 'Dermatology Review', 'Dental Hygiene', 'Wellness Check', 'Physio Session', 'Nutrition Follow-up', 'Skin Treatment', 'Annual Health MOT'];
  const apptStatuses = ['CONFIRMED', 'CONFIRMED', 'COMPLETED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'WAITLIST'] as const;
  const apptChannels = ['WHATSAPP', 'SMS', 'EMAIL', 'CALL'] as const;
  for (let i = 0; i < 16; i++) {
    const patient = patientPool[i % patientPool.length];
    const offsetDays = (i % 6) - 2; // -2..3 days around today
    const start = new Date(NOW + offsetDays * DAY);
    start.setHours(9 + (i % 8), (i % 2) * 30, 0, 0);
    await db.appointment.create({
      data: {
        tenantId, branchId: patient.branchId, patientId: patient.id,
        providerRef: ['Dr. Sarah Mitchell', 'Dr. James Okafor', 'Dr. Priya Sharma', 'Dr. Marcus Bell'][i % 4],
        service: services[i % services.length],
        startsAt: start, endsAt: new Date(start.getTime() + 30 * 60000),
        status: apptStatuses[i % apptStatuses.length], channel: apptChannels[i % apptChannels.length],
        value: 120 + (i % 7) * 65, noShowRisk: (i * 13) % 90,
      },
    });
  }
}

if (await db.lead.count({ where: { tenantId } }) === 0) {
  // Stage vocabulary matches the CRM pipeline board.
  const leadStages = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'];
  const leadChannels = ['WHATSAPP', 'SMS', 'EMAIL', 'CALL', 'PUSH'] as const;
  const leadServices = ['Botox & Fillers', 'Dental Implants', 'Skin Resurfacing', 'Weight Management', 'Physiotherapy', 'General Consultation', 'Teeth Whitening', 'Nutrition Plan'];
  const leadSources = ['Google Ads', 'Instagram', 'Referral', 'Website widget', 'Walk-in', 'WhatsApp inbound'];
  const leadNames = ['Hannah Reed', 'Victor Almeida', 'Priya Nair', 'Leo Fischer', 'Maya Goldberg', 'Caleb Wright', 'Ines Costa', 'Dylan Murphy'];
  await db.lead.createMany({
    data: leadNames.map((name, i) => ({
      tenantId, name,
      phone: `+44 7911 ${String(100000 + i * 7777).slice(0, 6)}`,
      email: `${name.split(' ')[0].toLowerCase()}@example.com`,
      channel: leadChannels[i % leadChannels.length],
      service: leadServices[i % leadServices.length],
      stage: leadStages[i % leadStages.length],
      source: leadSources[i % leadSources.length],
      estimatedValue: 250 + (i % 6) * 480,
    })),
  });
}

if (await db.campaign.count({ where: { tenantId } }) === 0) {
  await db.campaign.createMany({
    data: [
      { tenantId, name: 'Spring Skin Refresh', goal: 'Promote seasonal skincare packages', status: 'ACTIVE', channels: ['WHATSAPP', 'EMAIL'], audienceSize: 640, sent: 640, opened: 410, responded: 96, booked: 38, revenue: 18240, aiGenerated: true, startsAt: new Date(NOW - 12 * DAY) },
      { tenantId, name: 'Lapsed Patient Winback', goal: 'Reactivate 90-day inactive customers', status: 'ACTIVE', channels: ['SMS', 'EMAIL'], audienceSize: 187, sent: 187, opened: 88, responded: 31, booked: 14, revenue: 9650, aiGenerated: true, startsAt: new Date(NOW - 6 * DAY) },
      { tenantId, name: 'Weekday Slot Fill', goal: 'Fill empty weekday appointment slots', status: 'SCHEDULED', channels: ['WHATSAPP'], audienceSize: 84, sent: 0, opened: 0, responded: 0, booked: 0, revenue: 0, aiGenerated: true, startsAt: new Date(NOW + 2 * DAY) },
      { tenantId, name: 'Dental Check-up Reminder', goal: '6-month recall for dental patients', status: 'COMPLETED', channels: ['SMS', 'EMAIL'], audienceSize: 312, sent: 312, opened: 240, responded: 71, booked: 52, revenue: 22100, aiGenerated: false, startsAt: new Date(NOW - 40 * DAY), endsAt: new Date(NOW - 10 * DAY) },
      { tenantId, name: 'Summer Wellness Bundle', goal: 'Cross-sell nutrition + physio package', status: 'DRAFT', channels: ['EMAIL', 'PUSH'], audienceSize: 0, sent: 0, opened: 0, responded: 0, booked: 0, revenue: 0, aiGenerated: true },
      { tenantId, name: 'Referral Reward Drive', goal: 'Encourage VIP patient referrals', status: 'PAUSED', channels: ['WHATSAPP', 'EMAIL'], audienceSize: 95, sent: 60, opened: 44, responded: 18, booked: 9, revenue: 6300, aiGenerated: false, startsAt: new Date(NOW - 20 * DAY) },
    ],
  });
}

if (await db.review.count({ where: { tenantId } }) < 4) {
  const reviewData = [
    { rating: 5, text: 'Dr. Mitchell was fantastic — quick, thorough and genuinely caring.', platform: 'google', sentiment: 'positive', responded: true, branchId: BR.downtown },
    { rating: 4, text: 'Good treatment but the wait was a little long at reception.', platform: 'google', sentiment: 'neutral', responded: false, aiDraftResponse: 'Thank you for your feedback — we are actively working to reduce reception wait times.', branchId: BR.downtown },
    { rating: 2, text: 'Felt rushed during my appointment and follow-up was slow.', platform: 'google', sentiment: 'negative', responded: false, aiDraftResponse: 'We are sorry to hear this. We would love to make it right — please reach out so we can follow up properly.', branchId: BR.westside },
    { rating: 5, text: 'Best dental experience I have had. Marcus and the team are brilliant.', platform: 'internal', sentiment: 'positive', responded: true, branchId: BR.southbank },
    { rating: 5, text: 'The nutrition programme changed my habits completely. Highly recommend.', platform: 'google', sentiment: 'positive', responded: false, aiDraftResponse: 'Thank you so much! We are thrilled the nutrition programme made such a difference.', branchId: BR.northgate },
    { rating: 3, text: 'Decent care but pricing felt unclear until the end.', platform: 'internal', sentiment: 'neutral', responded: false, aiDraftResponse: 'Thanks for flagging this — we are improving how we share pricing up front.', branchId: BR.northgate },
    { rating: 1, text: 'Booking system double-charged me and it took days to resolve.', platform: 'google', sentiment: 'negative', responded: false, aiDraftResponse: 'We sincerely apologise for the billing issue. Our manager will personally make this right.', branchId: BR.westside },
    { rating: 4, text: 'Lovely clinic, modern and clean. Physio really helped my back.', platform: 'google', sentiment: 'positive', responded: true, branchId: BR.northgate },
  ];
  for (let i = 0; i < reviewData.length; i++) {
    const r = reviewData[i];
    await db.review.create({
      data: {
        tenantId, branchId: r.branchId, patientId: patientPool[i % patientPool.length].id,
        rating: r.rating, text: r.text, platform: r.platform, sentiment: r.sentiment,
        responded: r.responded, aiDraftResponse: r.aiDraftResponse ?? null,
        createdAt: new Date(NOW - (i + 1) * 2 * DAY),
      },
    });
  }
}

if (await db.inventoryItem.count({ where: { tenantId } }) === 0) {
  const inventory = [
    { name: 'Botox 100u Vial', category: 'Injectables', currentStock: 4, unit: 'vial', reorderLevel: 6, expiry: 95, unitCost: 320, usagePerWeek: 3, supplier: 'Allergan UK' },
    { name: 'Dermal Filler 1ml', category: 'Injectables', currentStock: 12, unit: 'syringe', reorderLevel: 8, expiry: 160, unitCost: 145, usagePerWeek: 5, supplier: 'Juvederm' },
    { name: 'Nitrile Gloves (M)', category: 'Consumables', currentStock: 0, unit: 'box', reorderLevel: 10, expiry: null, unitCost: 6, usagePerWeek: 14, supplier: 'MediSupply' },
    { name: 'Composite Resin A2', category: 'Dental', currentStock: 9, unit: 'tube', reorderLevel: 5, expiry: 40, unitCost: 28, usagePerWeek: 4, supplier: '3M Dental' },
    { name: 'Local Anaesthetic 2%', category: 'Pharmacy', currentStock: 22, unit: 'cartridge', reorderLevel: 20, expiry: 220, unitCost: 2, usagePerWeek: 18, supplier: 'Septodont' },
    { name: 'Surgical Masks', category: 'Consumables', currentStock: 35, unit: 'box', reorderLevel: 15, expiry: null, unitCost: 8, usagePerWeek: 9, supplier: 'MediSupply' },
    { name: 'Vitamin B12 Injection', category: 'Pharmacy', currentStock: 3, unit: 'vial', reorderLevel: 5, expiry: 25, unitCost: 14, usagePerWeek: 2, supplier: 'Wellness Labs' },
    { name: 'Chemical Peel Solution', category: 'Skincare', currentStock: 7, unit: 'bottle', reorderLevel: 4, expiry: 75, unitCost: 62, usagePerWeek: 2, supplier: 'SkinCeuticals' },
    { name: 'Dental Implant Kit', category: 'Dental', currentStock: 5, unit: 'kit', reorderLevel: 3, expiry: null, unitCost: 410, usagePerWeek: 1, supplier: 'Straumann' },
    { name: 'Hyaluronic Serum', category: 'Skincare', currentStock: 18, unit: 'bottle', reorderLevel: 10, expiry: 130, unitCost: 38, usagePerWeek: 6, supplier: 'SkinCeuticals' },
    { name: 'Sterile Gauze Pads', category: 'Consumables', currentStock: 2, unit: 'pack', reorderLevel: 12, expiry: null, unitCost: 4, usagePerWeek: 11, supplier: 'MediSupply' },
    { name: 'Physio Resistance Bands', category: 'Equipment', currentStock: 14, unit: 'set', reorderLevel: 6, expiry: null, unitCost: 9, usagePerWeek: 1, supplier: 'TheraBand' },
  ];
  const invBranches = [BR.downtown, BR.southbank, BR.northgate, BR.westside];
  await db.inventoryItem.createMany({
    data: inventory.map((item, i) => ({
      tenantId, branchId: invBranches[i % invBranches.length],
      name: item.name, category: item.category, currentStock: item.currentStock, unit: item.unit,
      reorderLevel: item.reorderLevel, expiryDate: item.expiry != null ? new Date(NOW + item.expiry * DAY) : null,
      unitCost: item.unitCost, usagePerWeek: item.usagePerWeek, supplier: item.supplier,
    })),
  });
}

// 6 months of network revenue history for the Revenue chart.
const revenueHistory = [
  { monthsAgo: 5, revenue: 286000, recovered: 19400, lost: 31200, campaigns: 12800 },
  { monthsAgo: 4, revenue: 298500, recovered: 22100, lost: 28700, campaigns: 14200 },
  { monthsAgo: 3, revenue: 312800, recovered: 24800, lost: 26900, campaigns: 15600 },
  { monthsAgo: 2, revenue: 321400, recovered: 26300, lost: 25400, campaigns: 16900 },
  { monthsAgo: 1, revenue: 329900, recovered: 27800, lost: 24800, campaigns: 17600 },
];
for (const snap of revenueHistory) {
  const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - snap.monthsAgo, 1));
  const existing = await db.revenueSnapshot.findFirst({ where: { tenantId, branchId: null, period } });
  if (!existing) {
    await db.revenueSnapshot.create({
      data: { tenantId, period, revenue: snap.revenue, recovered: snap.recovered, lost: snap.lost, campaigns: snap.campaigns },
    });
  }
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
