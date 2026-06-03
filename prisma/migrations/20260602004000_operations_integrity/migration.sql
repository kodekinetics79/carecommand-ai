-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffTask" ADD CONSTRAINT "StaffTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "Lead" ADD CONSTRAINT "Lead_estimatedValue_nonnegative" CHECK ("estimatedValue" >= 0);
ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_counts_nonnegative" CHECK ("audienceSize" >= 0 AND "sent" >= 0 AND "opened" >= 0 AND "responded" >= 0 AND "booked" >= 0),
  ADD CONSTRAINT "Campaign_revenue_nonnegative" CHECK ("revenue" >= 0);
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_stock_nonnegative" CHECK ("currentStock" >= 0 AND "reorderLevel" >= 0 AND "usagePerWeek" >= 0),
  ADD CONSTRAINT "InventoryItem_unitCost_nonnegative" CHECK ("unitCost" >= 0);
ALTER TABLE "RevenueSnapshot" ADD CONSTRAINT "RevenueSnapshot_values_nonnegative" CHECK ("revenue" >= 0 AND "recovered" >= 0 AND "lost" >= 0 AND "campaigns" >= 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_estimatedValue_nonnegative" CHECK ("estimatedValue" >= 0);
