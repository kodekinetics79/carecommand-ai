export interface ApiListResponse<T> {
  data: T[];
  nextCursor?: string;
}
