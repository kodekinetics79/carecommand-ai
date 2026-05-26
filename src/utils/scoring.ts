export const computeHealthScore = (utilization: number, missedCalls: number, openSlots: number): number => {
  const utilizationScore = Math.min(utilization, 100);
  const missedCallPenalty = Math.min(missedCalls * 2, 20);
  const openSlotPenalty = Math.min(openSlots * 0.5, 15);
  return Math.max(0, Math.round(utilizationScore - missedCallPenalty - openSlotPenalty));
};

export const computeChurnRisk = (daysSinceVisit: number, visitCount: number): number => {
  const recencyScore = Math.min(daysSinceVisit / 180 * 80, 80);
  const loyaltyBonus = Math.min(visitCount * 3, 20);
  return Math.max(0, Math.min(100, Math.round(recencyScore - loyaltyBonus + Math.random() * 10)));
};
