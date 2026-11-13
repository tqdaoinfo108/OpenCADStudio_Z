import { ProjectDocument } from './models.js';
import * as samples from '../js/verified_projects.js';

export const PROJECT_TOWNHOUSE_4F = new ProjectDocument(samples.PROJECT_TOWNHOUSE_4F);
export const PROJECT_VILLA_GARDEN_3F = new ProjectDocument(samples.PROJECT_VILLA_GARDEN_3F);
export const PROJECT_TOWNHOUSE_3F = new ProjectDocument(samples.PROJECT_TOWNHOUSE_3F);
export const SEED_PROJECTS = [PROJECT_TOWNHOUSE_4F, PROJECT_VILLA_GARDEN_3F, PROJECT_TOWNHOUSE_3F];
