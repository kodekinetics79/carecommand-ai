import { apiRequest } from './api';
import { branches, campaigns, patients, appointments, staffMembers, radarAlerts, reviews } from '../data/seedData';
import { formatCurrency } from '../utils/formatters';
import type {
  AdvisorResponse,
  AdvisorType,
  AdvisoryBriefResponse,
  AdvisoryAction,
} from '../types';

const advisorOrder: AdvisorType[] = ['revenue', 'growth', 'front-desk', 'competitor', 'operations'];

const advisorLabels: Record<AdvisorType, string> = {
  revenue: 'Revenue Advisor',
  growth: 'Growth Advisor',
  'front-desk': 'Front Desk Coach',
  competitor: 'Competitor Analyst',
  operations: 'Operations Advisor',
};

const advisorSampleQuestions: Record<AdvisorType, string[]> = {
  revenue: [
    'What is the fastest way to recover revenue this week?',
    'Where are the biggest leaks by clinic?',
    'Which campaign should I launch first?',
  ],
  growth: [
    'How should I grow bookings this month?',
    'Which patient segment should we reactivate?',
    'What campaign audience is most promising?',
  ],
  'front-desk': [
    'Where is the front desk losing the most value?',
    'Which staff members need coaching first?',
    'How do I reduce missed calls this week?',
  ],
  competitor: [
    'How should we respond to nearby competitors?',
    'What complaint themes are competitors missing?',
    'What should we counter in Clinic Radar?',
  ],
  operations: [
    'Where should I rebalance clinic capacity?',
    'What is the biggest operational bottleneck?',
    'How do I improve scheduling flow?',
  ],
};

function createAction(label: string, path: string, description: string, primary = false, context?: Record<string, unknown>): AdvisoryAction {
  return { label, path, description, primary, context };
}

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value: number | string | undefined | null) {
  return Number(value ?? 0);
}

function answerFromResponse(response: AdvisorResponse, question?: string) {
  const questionLine = question ? `Question: ${question}\n` : '';
  const evidenceLines = response.evidence.map(item => `- ${item}`).join('\n');
  const recommendationLines = response.recommendations.map(item => `- ${item}`).join('\n');
  const actionLines = response.actions.map(item => `- ${item.label}`).join('\n');
  return [
    questionLine,
    `Summary: ${response.summary}`,
    `Diagnosis: ${response.diagnosis}`,
    `Recommended action: ${response.recommendedAction}`,
    `Expected impact: ${formatCurrency(response.expectedImpact)}`,
    `Confidence: ${response.confidence}%`,
    'Evidence:',
    evidenceLines,
    'Recommendations:',
    recommendationLines,
    'Actions:',
    actionLines,
  ].filter(Boolean).join('\n');
}

function revenueResponse(question?: string): AdvisorResponse {
  const topLeak = radarAlerts.find(alert => alert.category === 'revenue' || alert.category === 'retention') ?? radarAlerts[0];
  const recoverable = radarAlerts.filter(alert => alert.estimatedValue).reduce((sum, alert) => sum + safeNumber(alert.estimatedValue), 0);
  const activeCampaigns = campaigns.filter(campaign => campaign.status === 'active').length;
  const inactivePatients = patients.filter(patient => patient.lifecycleStage === 'inactive' || patient.churnRisk >= 60).length;
  const response: AdvisorResponse = {
    advisorType: 'revenue',
    summary: `Recoverable value is sitting in ${inactivePatients} at-risk customers and ${activeCampaigns} active campaigns that can be used to recover demand.`,
    diagnosis: `Revenue is leaking where response time, follow-up, and campaign sequencing are not aligned around the highest-value patient segments.`,
    recommendedAction: 'Launch a recovery campaign against the top leak and assign the follow-up queue to the front desk today.',
    expectedImpact: Math.round(recoverable * 0.35 + inactivePatients * 140),
    confidence: 88,
    evidence: [
      topLeak ? `${topLeak.title} — ${formatCurrency(safeNumber(topLeak.estimatedValue))} at ${topLeak.severity} priority.` : 'No revenue signal found in the current dataset.',
      `${inactivePatients} customers are at-risk or inactive.`,
      `${activeCampaigns} campaigns are active and ready to reuse.`,
      `${appointments.filter(item => item.status === 'no-show' || item.status === 'risky').length} appointments carry no-show risk.`,
    ],
    recommendations: [
      'Prioritise the highest-value leak first.',
      'Re-use an existing campaign rather than creating a new audience from scratch.',
      'Tie the campaign to a same-day follow-up queue.',
    ],
    actions: [
      createAction('Open Revenue Leaks', '/opportunities', 'Review revenue leaks and operational opportunities', true),
      createAction('Create Campaign', '/campaigner', 'Launch a recovery campaign', false, { advisorType: 'revenue', question }),
      createAction('Open CRM', '/crm', 'Inspect at-risk patients and follow-up cohorts', false),
    ],
    answer: '',
    generatedAt: nowIso(),
  };
  response.answer = answerFromResponse(response, question);
  return response;
}

function growthResponse(question?: string): AdvisorResponse {
  const reactivationCount = patients.filter(patient => patient.lifecycleStage === 'inactive' || patient.lifecycleStage === 'at-risk').length;
  const activeCampaigns = campaigns.filter(campaign => campaign.status === 'active').length;
  const topCampaign = campaigns[0];
  const response: AdvisorResponse = {
    advisorType: 'growth',
    summary: `Growth is best unlocked through reactivation cohorts and the campaigns already performing in the library.`,
    diagnosis: `The strongest growth lever is to turn inactive patients into a structured audience and give them a deadline-driven offer.`,
    recommendedAction: 'Create a reactivation campaign for the highest-value inactive cohort and keep the message channel-specific.',
    expectedImpact: Math.round(reactivationCount * 180 + activeCampaigns * 220),
    confidence: 84,
    evidence: [
      `${reactivationCount} patients are inactive or at-risk.`,
      `${activeCampaigns} campaigns are already active in the library.`,
      topCampaign ? `Current campaign momentum: ${topCampaign.name} with ${topCampaign.audienceSize} audience.` : 'No campaign record available in the current dataset.',
      `The average customer has ${Math.round(patients.reduce((sum, patient) => sum + patient.visitCount, 0) / Math.max(patients.length, 1))} visits.`,
    ],
    recommendations: [
      'Reuse the best-performing segment from the current campaign library.',
      'Keep the offer short and channel-specific.',
      'Measure booked appointments within 7 days.',
    ],
    actions: [
      createAction('Create Campaign', '/campaigner', 'Start a reactivation campaign', true, { advisorType: 'growth', question }),
      createAction('Open CRM', '/crm', 'Review inactive patient segments', false),
      createAction('Open Opportunity Center', '/opportunities', 'Track growth value and follow-through', false),
    ],
    answer: '',
    generatedAt: nowIso(),
  };
  response.answer = answerFromResponse(response, question);
  return response;
}

function frontDeskResponse(question?: string): AdvisorResponse {
  const worstStaff = [...staffMembers].sort((left, right) => right.responseTime - left.responseTime)[0];
  const totalMissedCalls = staffMembers.reduce((sum, staff) => sum + staff.missedCalls, 0);
  const overdueTasks = 12;
  const response: AdvisorResponse = {
    advisorType: 'front-desk',
    summary: `Front desk performance is driven by response time, missed calls, and how quickly tasks move to completion.`,
    diagnosis: `A few staff members are carrying the slowest response times, and missed calls are still creating recoverable revenue.`,
    recommendedAction: 'Triage missed calls, clear overdue tasks, and coach the slowest responder first.',
    expectedImpact: Math.round(totalMissedCalls * 150 + overdueTasks * 90),
    confidence: 86,
    evidence: [
      worstStaff ? `${worstStaff.name} has the slowest response time at ${worstStaff.responseTime.toFixed(1)} minutes.` : 'No staff records available.',
      `${totalMissedCalls} missed calls are visible across the team.`,
      `${overdueTasks} follow-up tasks are still open or overdue.`,
      `${appointments.filter(item => item.noShowRisk >= 60).length} appointments carry a higher no-show risk.`,
    ],
    recommendations: [
      'Use the missed-call queue as the daily front desk priority.',
      'Review the slowest responders first.',
      'Keep the recovery playbook short and specific.',
    ],
    actions: [
      createAction('Review Staff Queue', '/staff', 'Open the staff task board and SLA view', true),
      createAction('Open AI Front Desk', '/ai-receptionist', 'Handle inbound replies and missed calls', false),
      createAction('Open CRM', '/crm', 'Move follow-up actions into the customer record', false),
    ],
    answer: '',
    generatedAt: nowIso(),
  };
  response.answer = answerFromResponse(response, question);
  return response;
}

function competitorResponse(question?: string): AdvisorResponse {
  const competitor = radarAlerts.find(alert => alert.category === 'reputation') ?? radarAlerts[0];
  const lowRatedReviews = reviews.filter(review => review.rating <= 3).length;
  const response: AdvisorResponse = {
    advisorType: 'competitor',
    summary: `Competitor pressure is mostly a reputation and response-speed problem, not a pricing problem.`,
    diagnosis: `Your advantage is to respond faster and recover reputation before competitors convert the complaint into a booking gap.`,
    recommendedAction: 'Counter the strongest competitor complaint theme with a response-speed and recovery campaign.',
    expectedImpact: Math.round(lowRatedReviews * 260 + (competitor?.estimatedValue ? safeNumber(competitor.estimatedValue) : 0)),
    confidence: 82,
    evidence: [
      competitor ? `${competitor.title} — ${competitor.description}` : 'No competitor alert data available.',
      `${lowRatedReviews} recent reviews are 3 stars or below.`,
      `${branches.length} clinics are in the network scope.`,
      `${appointments.filter(item => item.noShowRisk >= 60).length} high-risk appointments are available for recovery messaging.`,
    ],
    recommendations: [
      'Turn competitor complaint themes into the campaign opening line.',
      'Respond faster than the local market average.',
      'Route reputation recovery through a simple owner workflow.',
    ],
    actions: [
      createAction('Open Clinic Radar', '/clinic-radar', 'Inspect competitor signals', true),
      createAction('Create Campaign', '/campaigner', 'Launch a counter-campaign', false, { advisorType: 'competitor', question }),
      createAction('Open Revenue Leaks', '/opportunities', 'Match competitor gaps to revenue recovery', false),
    ],
    answer: '',
    generatedAt: nowIso(),
  };
  response.answer = answerFromResponse(response, question);
  return response;
}

function operationsResponse(question?: string): AdvisorResponse {
  const busiestBranch = branches[0];
  const totalMissedCalls = staffMembers.reduce((sum, staff) => sum + staff.missedCalls, 0);
  const response: AdvisorResponse = {
    advisorType: 'operations',
    summary: `Operations improve fastest when capacity, staffing, and the task queue are aligned on the same clinic.`,
    diagnosis: `The network is leaving efficiency on the table by not shifting capacity to the busiest branch and not clearing follow-up work quickly enough.`,
    recommendedAction: 'Balance capacity across clinics, then clear the task queue before launching more demand.',
    expectedImpact: Math.round(totalMissedCalls * 120 + appointments.filter(item => item.status === 'no-show' || item.status === 'risky').length * 140),
    confidence: 83,
    evidence: [
      busiestBranch ? `${busiestBranch.name} has the highest visible network activity.` : 'No branch data available.',
      `${appointments.filter(item => item.status === 'no-show' || item.status === 'risky').length} appointments are at higher no-show risk.`,
      `${staffMembers.reduce((sum, staff) => sum + staff.tasksPending, 0)} tasks are still pending across the team.`,
      `${totalMissedCalls} missed calls are still visible across the front desk team.`,
    ],
    recommendations: [
      'Use one clinic as the capacity benchmark.',
      'Clear overdue tasks before increasing demand.',
      'Keep the scheduling review tightly linked to front-desk coaching.',
    ],
    actions: [
      createAction('Open Scheduling', '/scheduling', 'Review capacity and no-show risk', true),
      createAction('Review Staff Queue', '/staff', 'Triage the task board and SLA view', false),
      createAction('Open Revenue Leaks', '/opportunities', 'See how operations affect revenue', false),
    ],
    answer: '',
    generatedAt: nowIso(),
  };
  response.answer = answerFromResponse(response, question);
  return response;
}

function localBrief(): AdvisoryBriefResponse {
  const advisors = advisorOrder.map(advisorType => {
    switch (advisorType) {
      case 'revenue':
        return revenueResponse();
      case 'growth':
        return growthResponse();
      case 'front-desk':
        return frontDeskResponse();
      case 'competitor':
        return competitorResponse();
      case 'operations':
        return operationsResponse();
    }
  });
  return {
    generatedAt: nowIso(),
    clinicName: 'Local demo fallback',
    advisors,
  };
}

function localAnswer(advisorType: AdvisorType, question: string) {
  switch (advisorType) {
    case 'revenue':
      return revenueResponse(question);
    case 'growth':
      return growthResponse(question);
    case 'front-desk':
      return frontDeskResponse(question);
    case 'competitor':
      return competitorResponse(question);
    case 'operations':
      return operationsResponse(question);
  }
}

export async function fetchAdvisoryBrief(clinicId?: string) {
  try {
    return await apiRequest<AdvisoryBriefResponse>(clinicId ? `/v1/advisory/brief?clinicId=${clinicId}` : '/v1/advisory/brief');
  } catch {
    return localBrief();
  }
}

export async function askAdvisory(question: string, advisorType: AdvisorType, clinicId?: string) {
  try {
    return await apiRequest<AdvisorResponse>('/v1/advisory/ask', {
      method: 'POST',
      body: JSON.stringify({ question, advisorType, clinicId }),
    });
  } catch {
    return localAnswer(advisorType, question);
  }
}

export function getAdvisorDisplay(advisorType: AdvisorType) {
  return advisorLabels[advisorType];
}

export function getAdvisorSampleQuestions(advisorType: AdvisorType) {
  return advisorSampleQuestions[advisorType];
}

