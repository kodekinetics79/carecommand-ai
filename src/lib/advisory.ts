import { apiRequest } from './api';
import type {
  AdvisorResponse,
  AdvisorType,
  AdvisoryBriefResponse,
} from '../types';

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

export async function fetchAdvisoryBrief(clinicId?: string) {
  return apiRequest<AdvisoryBriefResponse>(clinicId ? `/v1/advisory/brief?clinicId=${clinicId}` : '/v1/advisory/brief');
}

export async function askAdvisory(question: string, advisorType: AdvisorType, clinicId?: string) {
  return apiRequest<AdvisorResponse>('/v1/advisory/ask', {
    method: 'POST',
    body: JSON.stringify({ question, advisorType, clinicId }),
  });
}

export function getAdvisorDisplay(advisorType: AdvisorType) {
  return advisorLabels[advisorType];
}

export function getAdvisorSampleQuestions(advisorType: AdvisorType) {
  return advisorSampleQuestions[advisorType];
}
