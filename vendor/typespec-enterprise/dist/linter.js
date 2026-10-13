import { defineLinter } from '@typespec/compiler';
import { allRules } from './rules.js';
export const $linter = defineLinter({
    rules: allRules,
    ruleSets: {
        recommended: {
            enable: {
                '@superschema/typespec-enterprise/require-documentation': true,
                '@superschema/typespec-enterprise/require-classification': true,
                '@superschema/typespec-enterprise/require-key': true,
                '@superschema/typespec-enterprise/pii-requires-anonymization': true,
                '@superschema/typespec-enterprise/pii-requires-restricted-classification': true,
                '@superschema/typespec-enterprise/decimal-requires-precision': true,
                '@superschema/typespec-enterprise/avro-fixed-requires-size': true,
                '@superschema/typespec-enterprise/protobuf-no-duplicate-field-numbers': true,
            },
        },
        strict: {
            extends: ['@superschema/typespec-enterprise/recommended'],
        },
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGludGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2xpbnRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFDbEQsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUV0QyxNQUFNLENBQUMsTUFBTSxPQUFPLEdBQUcsWUFBWSxDQUFDO0lBQ2xDLEtBQUssRUFBRSxRQUFRO0lBQ2YsUUFBUSxFQUFFO1FBQ1IsV0FBVyxFQUFFO1lBQ1gsTUFBTSxFQUFFO2dCQUNOLHdEQUF3RCxFQUFFLElBQUk7Z0JBQzlELHlEQUF5RCxFQUFFLElBQUk7Z0JBQy9ELDhDQUE4QyxFQUFFLElBQUk7Z0JBQ3BELDZEQUE2RCxFQUFFLElBQUk7Z0JBQ25FLHlFQUF5RSxFQUFFLElBQUk7Z0JBQy9FLDZEQUE2RCxFQUFFLElBQUk7Z0JBQ25FLDJEQUEyRCxFQUFFLElBQUk7Z0JBQ2pFLHNFQUFzRSxFQUFFLElBQUk7YUFDN0U7U0FDRjtRQUNELE1BQU0sRUFBRTtZQUNOLE9BQU8sRUFBRSxDQUFDLDhDQUE4QyxDQUFDO1NBQzFEO0tBQ0Y7Q0FDRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBkZWZpbmVMaW50ZXIgfSBmcm9tICdAdHlwZXNwZWMvY29tcGlsZXInO1xuaW1wb3J0IHsgYWxsUnVsZXMgfSBmcm9tICcuL3J1bGVzLmpzJztcblxuZXhwb3J0IGNvbnN0ICRsaW50ZXIgPSBkZWZpbmVMaW50ZXIoe1xuICBydWxlczogYWxsUnVsZXMsXG4gIHJ1bGVTZXRzOiB7XG4gICAgcmVjb21tZW5kZWQ6IHtcbiAgICAgIGVuYWJsZToge1xuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvcmVxdWlyZS1kb2N1bWVudGF0aW9uJzogdHJ1ZSxcbiAgICAgICAgJ0BzdXBlcnNjaGVtYS90eXBlc3BlYy1lbnRlcnByaXNlL3JlcXVpcmUtY2xhc3NpZmljYXRpb24nOiB0cnVlLFxuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvcmVxdWlyZS1rZXknOiB0cnVlLFxuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvcGlpLXJlcXVpcmVzLWFub255bWl6YXRpb24nOiB0cnVlLFxuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvcGlpLXJlcXVpcmVzLXJlc3RyaWN0ZWQtY2xhc3NpZmljYXRpb24nOiB0cnVlLFxuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvZGVjaW1hbC1yZXF1aXJlcy1wcmVjaXNpb24nOiB0cnVlLFxuICAgICAgICAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvYXZyby1maXhlZC1yZXF1aXJlcy1zaXplJzogdHJ1ZSxcbiAgICAgICAgJ0BzdXBlcnNjaGVtYS90eXBlc3BlYy1lbnRlcnByaXNlL3Byb3RvYnVmLW5vLWR1cGxpY2F0ZS1maWVsZC1udW1iZXJzJzogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBzdHJpY3Q6IHtcbiAgICAgIGV4dGVuZHM6IFsnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UvcmVjb21tZW5kZWQnXSxcbiAgICB9LFxuICB9LFxufSk7XG4iXX0=