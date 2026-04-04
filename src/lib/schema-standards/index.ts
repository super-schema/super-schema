import commonFieldsData from "./common-fields.json";
import commonPatternsData from "./common-patterns.json";

export interface StandardField {
  name: string;
  suggestedType: string;
  suggestedClassification?: string;
  description: string;
}

export const commonFields: StandardField[] = commonFieldsData as StandardField[];
export const commonPatterns: StandardField[] = commonPatternsData as StandardField[];
