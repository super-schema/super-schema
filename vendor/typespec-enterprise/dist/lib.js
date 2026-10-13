import { createTypeSpecLibrary, paramMessage } from '@typespec/compiler';
const PACKAGE_NAME = '@superschema/typespec-enterprise';
export const $lib = createTypeSpecLibrary({
    name: PACKAGE_NAME,
    diagnostics: {
        'require-documentation': {
            severity: 'warning',
            messages: {
                default: paramMessage `${'target'} must have documentation`,
            },
        },
        'require-classification': {
            severity: 'warning',
            messages: {
                default: paramMessage `${'target'} must have @dataClassification`,
            },
        },
        'require-key': {
            severity: 'warning',
            messages: {
                default: paramMessage `Model '${'model'}' must have @key property`,
            },
        },
        'pii-requires-anonymization': {
            severity: 'error',
            messages: {
                default: paramMessage `PII property '${'property'}' requires @anonymization`,
            },
        },
        'pii-requires-restricted-classification': {
            severity: 'error',
            messages: {
                default: paramMessage `PII property must have restricted classification`,
            },
        },
        'decimal-requires-precision': {
            severity: 'warning',
            messages: {
                default: paramMessage `Decimal property '${'property'}' requires @precision`,
            },
        },
        'avro-fixed-requires-size': {
            severity: 'error',
            messages: {
                default: paramMessage `Property '${'property'}' has @avroLogicalType(fixed) but no @avroFixedSize`,
            },
        },
        'protobuf-no-duplicate-field-numbers': {
            severity: 'error',
            messages: {
                default: paramMessage `Model '${'model'}' has duplicate @protobufFieldNumber value ${'number'} on properties '${'first'}' and '${'second'}'`,
            },
        },
    },
});
export const { reportDiagnostic, createDiagnostic } = $lib;
// Every decorator's state symbol, created through $lib so the compiler's
// state-management/projection machinery recognizes them as belonging to
// this library (plain Symbol() would also work functionally, but this is
// the convention real packages use, confirmed against packages/bigquery
// in the sibling ~/src/my/typespec checkout, compiler 1.10.0).
const STATE_KEYS = [
    'dataClassification', 'pii', 'businessOwner', 'steward', 'retentionPolicy',
    'anonymization', 'qualityRule', 'precision', 'sourceMapping',
    'avroLogicalType', 'avroFixedSize', 'avroOrder', 'avroNamespace', 'avroRecordAliases',
    'protobufFieldNumber', 'protobufOneofGroup',
    'partitionHint', 'indexHint', 'clusterHint', 'deprecation',
];
export const state = Object.fromEntries(STATE_KEYS.map((k) => [k, $lib.createStateSymbol(k)]));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2xpYi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUscUJBQXFCLEVBQUUsWUFBWSxFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFFekUsTUFBTSxZQUFZLEdBQUcsa0NBQWtDLENBQUM7QUFFeEQsTUFBTSxDQUFDLE1BQU0sSUFBSSxHQUFHLHFCQUFxQixDQUFDO0lBQ3hDLElBQUksRUFBRSxZQUFZO0lBQ2xCLFdBQVcsRUFBRTtRQUNYLHVCQUF1QixFQUFFO1lBQ3ZCLFFBQVEsRUFBRSxTQUFTO1lBQ25CLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLEdBQUcsUUFBUSwwQkFBMEI7YUFDM0Q7U0FDRjtRQUNELHdCQUF3QixFQUFFO1lBQ3hCLFFBQVEsRUFBRSxTQUFTO1lBQ25CLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLEdBQUcsUUFBUSxnQ0FBZ0M7YUFDakU7U0FDRjtRQUNELGFBQWEsRUFBRTtZQUNiLFFBQVEsRUFBRSxTQUFTO1lBQ25CLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLFVBQVUsT0FBTywyQkFBMkI7YUFDbEU7U0FDRjtRQUNELDRCQUE0QixFQUFFO1lBQzVCLFFBQVEsRUFBRSxPQUFPO1lBQ2pCLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLGlCQUFpQixVQUFVLDJCQUEyQjthQUM1RTtTQUNGO1FBQ0Qsd0NBQXdDLEVBQUU7WUFDeEMsUUFBUSxFQUFFLE9BQU87WUFDakIsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxZQUFZLENBQUEsa0RBQWtEO2FBQ3hFO1NBQ0Y7UUFDRCw0QkFBNEIsRUFBRTtZQUM1QixRQUFRLEVBQUUsU0FBUztZQUNuQixRQUFRLEVBQUU7Z0JBQ1IsT0FBTyxFQUFFLFlBQVksQ0FBQSxxQkFBcUIsVUFBVSx1QkFBdUI7YUFDNUU7U0FDRjtRQUNELDBCQUEwQixFQUFFO1lBQzFCLFFBQVEsRUFBRSxPQUFPO1lBQ2pCLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLGFBQWEsVUFBVSxxREFBcUQ7YUFDbEc7U0FDRjtRQUNELHFDQUFxQyxFQUFFO1lBQ3JDLFFBQVEsRUFBRSxPQUFPO1lBQ2pCLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsWUFBWSxDQUFBLFVBQVUsT0FBTyw4Q0FBOEMsUUFBUSxtQkFBbUIsT0FBTyxVQUFVLFFBQVEsR0FBRzthQUM1STtTQUNGO0tBQ0Y7Q0FDRixDQUFDLENBQUM7QUFHSCxNQUFNLENBQUMsTUFBTSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLEdBQUcsSUFBSSxDQUFDO0FBRTNELHlFQUF5RTtBQUN6RSx3RUFBd0U7QUFDeEUseUVBQXlFO0FBQ3pFLHdFQUF3RTtBQUN4RSwrREFBK0Q7QUFDL0QsTUFBTSxVQUFVLEdBQUc7SUFDakIsb0JBQW9CLEVBQUUsS0FBSyxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsaUJBQWlCO0lBQzFFLGVBQWUsRUFBRSxhQUFhLEVBQUUsV0FBVyxFQUFFLGVBQWU7SUFDNUQsaUJBQWlCLEVBQUUsZUFBZSxFQUFFLFdBQVcsRUFBRSxlQUFlLEVBQUUsbUJBQW1CO0lBQ3JGLHFCQUFxQixFQUFFLG9CQUFvQjtJQUMzQyxlQUFlLEVBQUUsV0FBVyxFQUFFLGFBQWEsRUFBRSxhQUFhO0NBQ2xELENBQUM7QUFFWCxNQUFNLENBQUMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLFdBQVcsQ0FDckMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlVHlwZVNwZWNMaWJyYXJ5LCBwYXJhbU1lc3NhZ2UgfSBmcm9tICdAdHlwZXNwZWMvY29tcGlsZXInO1xuXG5jb25zdCBQQUNLQUdFX05BTUUgPSAnQHN1cGVyc2NoZW1hL3R5cGVzcGVjLWVudGVycHJpc2UnO1xuXG5leHBvcnQgY29uc3QgJGxpYiA9IGNyZWF0ZVR5cGVTcGVjTGlicmFyeSh7XG4gIG5hbWU6IFBBQ0tBR0VfTkFNRSxcbiAgZGlhZ25vc3RpY3M6IHtcbiAgICAncmVxdWlyZS1kb2N1bWVudGF0aW9uJzoge1xuICAgICAgc2V2ZXJpdHk6ICd3YXJuaW5nJyxcbiAgICAgIG1lc3NhZ2VzOiB7XG4gICAgICAgIGRlZmF1bHQ6IHBhcmFtTWVzc2FnZWAkeyd0YXJnZXQnfSBtdXN0IGhhdmUgZG9jdW1lbnRhdGlvbmAsXG4gICAgICB9LFxuICAgIH0sXG4gICAgJ3JlcXVpcmUtY2xhc3NpZmljYXRpb24nOiB7XG4gICAgICBzZXZlcml0eTogJ3dhcm5pbmcnLFxuICAgICAgbWVzc2FnZXM6IHtcbiAgICAgICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYCR7J3RhcmdldCd9IG11c3QgaGF2ZSBAZGF0YUNsYXNzaWZpY2F0aW9uYCxcbiAgICAgIH0sXG4gICAgfSxcbiAgICAncmVxdWlyZS1rZXknOiB7XG4gICAgICBzZXZlcml0eTogJ3dhcm5pbmcnLFxuICAgICAgbWVzc2FnZXM6IHtcbiAgICAgICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYE1vZGVsICckeydtb2RlbCd9JyBtdXN0IGhhdmUgQGtleSBwcm9wZXJ0eWAsXG4gICAgICB9LFxuICAgIH0sXG4gICAgJ3BpaS1yZXF1aXJlcy1hbm9ueW1pemF0aW9uJzoge1xuICAgICAgc2V2ZXJpdHk6ICdlcnJvcicsXG4gICAgICBtZXNzYWdlczoge1xuICAgICAgICBkZWZhdWx0OiBwYXJhbU1lc3NhZ2VgUElJIHByb3BlcnR5ICckeydwcm9wZXJ0eSd9JyByZXF1aXJlcyBAYW5vbnltaXphdGlvbmAsXG4gICAgICB9LFxuICAgIH0sXG4gICAgJ3BpaS1yZXF1aXJlcy1yZXN0cmljdGVkLWNsYXNzaWZpY2F0aW9uJzoge1xuICAgICAgc2V2ZXJpdHk6ICdlcnJvcicsXG4gICAgICBtZXNzYWdlczoge1xuICAgICAgICBkZWZhdWx0OiBwYXJhbU1lc3NhZ2VgUElJIHByb3BlcnR5IG11c3QgaGF2ZSByZXN0cmljdGVkIGNsYXNzaWZpY2F0aW9uYCxcbiAgICAgIH0sXG4gICAgfSxcbiAgICAnZGVjaW1hbC1yZXF1aXJlcy1wcmVjaXNpb24nOiB7XG4gICAgICBzZXZlcml0eTogJ3dhcm5pbmcnLFxuICAgICAgbWVzc2FnZXM6IHtcbiAgICAgICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYERlY2ltYWwgcHJvcGVydHkgJyR7J3Byb3BlcnR5J30nIHJlcXVpcmVzIEBwcmVjaXNpb25gLFxuICAgICAgfSxcbiAgICB9LFxuICAgICdhdnJvLWZpeGVkLXJlcXVpcmVzLXNpemUnOiB7XG4gICAgICBzZXZlcml0eTogJ2Vycm9yJyxcbiAgICAgIG1lc3NhZ2VzOiB7XG4gICAgICAgIGRlZmF1bHQ6IHBhcmFtTWVzc2FnZWBQcm9wZXJ0eSAnJHsncHJvcGVydHknfScgaGFzIEBhdnJvTG9naWNhbFR5cGUoZml4ZWQpIGJ1dCBubyBAYXZyb0ZpeGVkU2l6ZWAsXG4gICAgICB9LFxuICAgIH0sXG4gICAgJ3Byb3RvYnVmLW5vLWR1cGxpY2F0ZS1maWVsZC1udW1iZXJzJzoge1xuICAgICAgc2V2ZXJpdHk6ICdlcnJvcicsXG4gICAgICBtZXNzYWdlczoge1xuICAgICAgICBkZWZhdWx0OiBwYXJhbU1lc3NhZ2VgTW9kZWwgJyR7J21vZGVsJ30nIGhhcyBkdXBsaWNhdGUgQHByb3RvYnVmRmllbGROdW1iZXIgdmFsdWUgJHsnbnVtYmVyJ30gb24gcHJvcGVydGllcyAnJHsnZmlyc3QnfScgYW5kICckeydzZWNvbmQnfSdgLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxufSk7XG5cbmV4cG9ydCB0eXBlIEVudGVycHJpc2VMaWJyYXJ5ID0gdHlwZW9mICRsaWI7XG5leHBvcnQgY29uc3QgeyByZXBvcnREaWFnbm9zdGljLCBjcmVhdGVEaWFnbm9zdGljIH0gPSAkbGliO1xuXG4vLyBFdmVyeSBkZWNvcmF0b3IncyBzdGF0ZSBzeW1ib2wsIGNyZWF0ZWQgdGhyb3VnaCAkbGliIHNvIHRoZSBjb21waWxlcidzXG4vLyBzdGF0ZS1tYW5hZ2VtZW50L3Byb2plY3Rpb24gbWFjaGluZXJ5IHJlY29nbml6ZXMgdGhlbSBhcyBiZWxvbmdpbmcgdG9cbi8vIHRoaXMgbGlicmFyeSAocGxhaW4gU3ltYm9sKCkgd291bGQgYWxzbyB3b3JrIGZ1bmN0aW9uYWxseSwgYnV0IHRoaXMgaXNcbi8vIHRoZSBjb252ZW50aW9uIHJlYWwgcGFja2FnZXMgdXNlLCBjb25maXJtZWQgYWdhaW5zdCBwYWNrYWdlcy9iaWdxdWVyeVxuLy8gaW4gdGhlIHNpYmxpbmcgfi9zcmMvbXkvdHlwZXNwZWMgY2hlY2tvdXQsIGNvbXBpbGVyIDEuMTAuMCkuXG5jb25zdCBTVEFURV9LRVlTID0gW1xuICAnZGF0YUNsYXNzaWZpY2F0aW9uJywgJ3BpaScsICdidXNpbmVzc093bmVyJywgJ3N0ZXdhcmQnLCAncmV0ZW50aW9uUG9saWN5JyxcbiAgJ2Fub255bWl6YXRpb24nLCAncXVhbGl0eVJ1bGUnLCAncHJlY2lzaW9uJywgJ3NvdXJjZU1hcHBpbmcnLFxuICAnYXZyb0xvZ2ljYWxUeXBlJywgJ2F2cm9GaXhlZFNpemUnLCAnYXZyb09yZGVyJywgJ2F2cm9OYW1lc3BhY2UnLCAnYXZyb1JlY29yZEFsaWFzZXMnLFxuICAncHJvdG9idWZGaWVsZE51bWJlcicsICdwcm90b2J1Zk9uZW9mR3JvdXAnLFxuICAncGFydGl0aW9uSGludCcsICdpbmRleEhpbnQnLCAnY2x1c3RlckhpbnQnLCAnZGVwcmVjYXRpb24nLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IHN0YXRlID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICBTVEFURV9LRVlTLm1hcCgoaykgPT4gW2ssICRsaWIuY3JlYXRlU3RhdGVTeW1ib2woayldKVxuKSBhcyB7IFtLIGluICh0eXBlb2YgU1RBVEVfS0VZUylbbnVtYmVyXV06IHN5bWJvbCB9O1xuIl19