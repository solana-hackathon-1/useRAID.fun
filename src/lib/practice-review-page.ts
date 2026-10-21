import { createPracticeReviewPageLoader } from '../skills/practice-review-page';
import { practiceReviewHandlers } from './practice-review-http';
export const loadPracticeReviewPage = createPracticeReviewPageLoader(practiceReviewHandlers.GET);
