import { createRule, paramMessage, isKey } from '@typespec/compiler';
import { getDataClassification, isPii, getAnonymization, getPrecision, getAvroLogicalType, getAvroFixedSize, getProtobufFieldNumber, } from './decorators.js';
export const requireDocumentation = createRule({
    name: 'require-documentation',
    description: 'All models and properties must have documentation',
    severity: 'warning',
    messages: {
        default: paramMessage `${'target'} must have documentation (@doc decorator)`,
    },
    create(context) {
        return {
            model: (model) => {
                if (!model.node?.docs && !model.decorators.some(d => d.decorator.name === '$doc')) {
                    context.reportDiagnostic({
                        target: model,
                        messageId: 'default',
                        format: { target: `Model '${model.name}'` },
                    });
                }
            },
            modelProperty: (property) => {
                if (!property.node?.docs && !property.decorators.some(d => d.decorator.name === '$doc')) {
                    context.reportDiagnostic({
                        target: property,
                        messageId: 'default',
                        format: { target: `Property '${property.name}'` },
                    });
                }
            },
        };
    },
});
export const requireClassification = createRule({
    name: 'require-classification',
    description: 'All models and properties must have data classification',
    severity: 'warning',
    messages: {
        default: paramMessage `${'target'} must have @dataClassification decorator`,
    },
    create(context) {
        return {
            model: (model) => {
                if (!getDataClassification(context.program, model)) {
                    context.reportDiagnostic({
                        target: model,
                        messageId: 'default',
                        format: { target: `Model '${model.name}'` },
                    });
                }
            },
        };
    },
});
export const requireKey = createRule({
    name: 'require-key',
    description: 'Each model must have at least one @key property',
    severity: 'warning',
    messages: {
        default: paramMessage `Model '${'model'}' must have at least one property marked with @key`,
    },
    create(context) {
        return {
            model: (model) => {
                let hasKey = false;
                for (const [, prop] of model.properties) {
                    if (isKey(context.program, prop)) {
                        hasKey = true;
                        break;
                    }
                }
                if (!hasKey && model.properties.size > 0) {
                    context.reportDiagnostic({
                        target: model,
                        messageId: 'default',
                        format: { model: model.name },
                    });
                }
            },
        };
    },
});
export const piiRequiresAnonymization = createRule({
    name: 'pii-requires-anonymization',
    description: 'PII properties must have anonymization strategy specified',
    // Rule-level severity is structurally "warning"-only in this compiler
    // version; the real error severity is on the 'pii-requires-anonymization'
    // diagnostic code (lib.ts / index.ts), which reportDiagnostic uses.
    severity: 'warning',
    messages: {
        default: paramMessage `Property '${'property'}' is marked as PII but has no @anonymization strategy`,
    },
    create(context) {
        return {
            modelProperty: (property) => {
                if (isPii(context.program, property) && !getAnonymization(context.program, property)) {
                    context.reportDiagnostic({
                        target: property,
                        messageId: 'default',
                        format: { property: property.name },
                    });
                }
            },
        };
    },
});
export const piiRequiresRestrictedClassification = createRule({
    name: 'pii-requires-restricted-classification',
    description: 'PII properties must have Restricted, Confidential, or PII classification',
    severity: 'warning',
    messages: {
        default: paramMessage `Property '${'property'}' is marked as PII but has classification '${'classification'}' (must be Restricted, Confidential, or PII)`,
    },
    create(context) {
        return {
            modelProperty: (property) => {
                if (isPii(context.program, property)) {
                    const classification = getDataClassification(context.program, property);
                    const validClassifications = ['Restricted', 'Confidential', 'PII'];
                    if (classification && !validClassifications.includes(classification)) {
                        context.reportDiagnostic({
                            target: property,
                            messageId: 'default',
                            format: { property: property.name, classification },
                        });
                    }
                }
            },
        };
    },
});
export const decimalRequiresPrecision = createRule({
    name: 'decimal-requires-precision',
    description: 'Decimal/numeric fields must have @precision specified',
    severity: 'warning',
    messages: {
        default: paramMessage `Property '${'property'}' appears to be decimal/numeric but has no @precision specified`,
    },
    create(context) {
        return {
            modelProperty: (property) => {
                const type = property.type;
                if (type.kind === 'Scalar') {
                    const scalarName = type.name.toLowerCase();
                    if (['decimal', 'decimal128', 'float', 'float64', 'numeric'].includes(scalarName)) {
                        if (!getPrecision(context.program, property)) {
                            context.reportDiagnostic({
                                target: property,
                                messageId: 'default',
                                format: { property: property.name },
                            });
                        }
                    }
                }
            },
        };
    },
});
export const avroFixedRequiresSize = createRule({
    name: 'avro-fixed-requires-size',
    description: '@avroLogicalType(fixed) requires @avroFixedSize',
    severity: 'warning',
    messages: {
        default: paramMessage `Property '${'property'}' has @avroLogicalType(fixed) but no @avroFixedSize`,
    },
    create(context) {
        return {
            modelProperty: (property) => {
                if (getAvroLogicalType(context.program, property) === 'fixed' &&
                    getAvroFixedSize(context.program, property) === undefined) {
                    context.reportDiagnostic({
                        target: property,
                        messageId: 'default',
                        format: { property: property.name },
                    });
                }
            },
        };
    },
});
export const protobufNoDuplicateFieldNumbers = createRule({
    name: 'protobuf-no-duplicate-field-numbers',
    description: 'Protobuf field numbers must be unique within a model',
    severity: 'warning',
    messages: {
        default: paramMessage `Model '${'model'}' has duplicate @protobufFieldNumber value ${'number'} on properties '${'first'}' and '${'second'}'`,
    },
    create(context) {
        return {
            model: (model) => {
                const seen = new Map();
                for (const [, prop] of model.properties) {
                    const num = getProtobufFieldNumber(context.program, prop);
                    if (num === undefined)
                        continue;
                    const existing = seen.get(num);
                    if (existing) {
                        context.reportDiagnostic({
                            target: prop,
                            messageId: 'default',
                            format: { model: model.name, number: String(num), first: existing, second: prop.name },
                        });
                    }
                    else {
                        seen.set(num, prop.name);
                    }
                }
            },
        };
    },
});
export const allRules = [
    requireDocumentation,
    requireClassification,
    requireKey,
    piiRequiresAnonymization,
    piiRequiresRestrictedClassification,
    decimalRequiresPrecision,
    avroFixedRequiresSize,
    protobufNoDuplicateFieldNumbers,
];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVsZXMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvcnVsZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQWlDLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQ3BHLE9BQU8sRUFDTCxxQkFBcUIsRUFDckIsS0FBSyxFQUNMLGdCQUFnQixFQUNoQixZQUFZLEVBQ1osa0JBQWtCLEVBQ2xCLGdCQUFnQixFQUNoQixzQkFBc0IsR0FDdkIsTUFBTSxpQkFBaUIsQ0FBQztBQUV6QixNQUFNLENBQUMsTUFBTSxvQkFBb0IsR0FBRyxVQUFVLENBQUM7SUFDN0MsSUFBSSxFQUFFLHVCQUF1QjtJQUM3QixXQUFXLEVBQUUsbURBQW1EO0lBQ2hFLFFBQVEsRUFBRSxTQUFTO0lBQ25CLFFBQVEsRUFBRTtRQUNSLE9BQU8sRUFBRSxZQUFZLENBQUEsR0FBRyxRQUFRLDJDQUEyQztLQUM1RTtJQUNELE1BQU0sQ0FBQyxPQUFPO1FBQ1osT0FBTztZQUNMLEtBQUssRUFBRSxDQUFDLEtBQVksRUFBRSxFQUFFO2dCQUN0QixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsSUFBSSxLQUFLLE1BQU0sQ0FBQyxFQUFFLENBQUM7b0JBQ2xGLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQzt3QkFDdkIsTUFBTSxFQUFFLEtBQUs7d0JBQ2IsU0FBUyxFQUFFLFNBQVM7d0JBQ3BCLE1BQU0sRUFBRSxFQUFFLE1BQU0sRUFBRSxVQUFVLEtBQUssQ0FBQyxJQUFJLEdBQUcsRUFBRTtxQkFDNUMsQ0FBQyxDQUFDO2dCQUNMLENBQUM7WUFDSCxDQUFDO1lBQ0QsYUFBYSxFQUFFLENBQUMsUUFBdUIsRUFBRSxFQUFFO2dCQUN6QyxJQUFJLENBQUMsUUFB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TW9kZWwsIE1vZGVsUHJvcGVydHksIGlzS2V5IH0gZnJvbSAnQHR5cGVzcGVjL2NvbXBpbGVyJztcbmltcG9ydCB7XG4gIGdldERhdGFDbGFzc2lmaWNhdGlvbixcbiAgaXNQaWksXG4gIGdldEFub255bWl6YXRpb24sXG4gIGdldFByZWNpc2lvbixcbiAgZ2V0QXZyb0xvZ2ljYWxUeXBlLFxuICBnZXRBdnJvRml4ZWRTaXplLFxuICBnZXRQcm90b2J1ZkZpZWxkTnVtYmVyLFxufSBmcm9tICcuL2RlY29yYXRvcnMuanMnO1xuXG5leHBvcnQgY29uc3QgcmVxdWlyZURvY3VtZW50YXRpb24gPSBjcmVhdGVSdWxlKHtcbiAgbmFtZTogJ3JlcXVpcmUtZG9jdW1lbnRhdGlvbicsXG4gIGRlc2NyaXB0aW9uOiAnQWxsIG1vZGVscyBhbmQgcHJvcGVydGllcyBtdXN0IGhhdmUgZG9jdW1lbnRhdGlvbicsXG4gIHNldmVyaXR5OiAnd2FybmluZycsXG4gIG1lc3NhZ2VzOiB7XG4gICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYCR7J3RhcmdldCd9IG11c3QgaGF2ZSBkb2N1bWVudGF0aW9uIChAZG9jIGRlY29yYXRvcilgLFxuICB9LFxuICBjcmVhdGUoY29udGV4dCkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlbDogKG1vZGVsOiBNb2RlbCkgPT4ge1xuICAgICAgICBpZiAoIW1vZGVsLm5vZGU/LmRvY3MgJiYgIW1vZGVsLmRlY29yYXRvcnMuc29tZShkID0+IGQuZGVjb3JhdG9yLm5hbWUgPT09ICckZG9jJykpIHtcbiAgICAgICAgICBjb250ZXh0LnJlcG9ydERpYWdub3N0aWMoe1xuICAgICAgICAgICAgdGFyZ2V0OiBtb2RlbCxcbiAgICAgICAgICAgIG1lc3NhZ2VJZDogJ2RlZmF1bHQnLFxuICAgICAgICAgICAgZm9ybWF0OiB7IHRhcmdldDogYE1vZGVsICcke21vZGVsLm5hbWV9J2AgfSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIG1vZGVsUHJvcGVydHk6IChwcm9wZXJ0eTogTW9kZWxQcm9wZXJ0eSkgPT4ge1xuICAgICAgICBpZiAoIXByb3BlcnR5Lm5vZGU/LmRvY3MgJiYgIXByb3BlcnR5LmRlY29yYXRvcnMuc29tZShkID0+IGQuZGVjb3JhdG9yLm5hbWUgPT09ICckZG9jJykpIHtcbiAgICAgICAgICBjb250ZXh0LnJlcG9ydERpYWdub3N0aWMoe1xuICAgICAgICAgICAgdGFyZ2V0OiBwcm9wZXJ0eSxcbiAgICAgICAgICAgIG1lc3NhZ2VJZDogJ2RlZmF1bHQnLFxuICAgICAgICAgICAgZm9ybWF0OiB7IHRhcmdldDogYFByb3BlcnR5ICcke3Byb3BlcnR5Lm5hbWV9J2AgfSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9O1xuICB9LFxufSk7XG5cbmV4cG9ydCBjb25zdCByZXF1aXJlQ2xhc3NpZmljYXRpb24gPSBjcmVhdGVSdWxlKHtcbiAgbmFtZTogJ3JlcXVpcmUtY2xhc3NpZmljYXRpb24nLFxuICBkZXNjcmlwdGlvbjogJ0FsbCBtb2RlbHMgYW5kIHByb3BlcnRpZXMgbXVzdCBoYXZlIGRhdGEgY2xhc3NpZmljYXRpb24nLFxuICBzZXZlcml0eTogJ3dhcm5pbmcnLFxuICBtZXNzYWdlczoge1xuICAgIGRlZmF1bHQ6IHBhcmFtTWVzc2FnZWAkeyd0YXJnZXQnfSBtdXN0IGhhdmUgQGRhdGFDbGFzc2lmaWNhdGlvbiBkZWNvcmF0b3JgLFxuICB9LFxuICBjcmVhdGUoY29udGV4dCkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlbDogKG1vZGVsOiBNb2RlbCkgPT4ge1xuICAgICAgICBpZiAoIWdldERhdGFDbGFzc2lmaWNhdGlvbihjb250ZXh0LnByb2dyYW0sIG1vZGVsKSkge1xuICAgICAgICAgIGNvbnRleHQucmVwb3J0RGlhZ25vc3RpYyh7XG4gICAgICAgICAgICB0YXJnZXQ6IG1vZGVsLFxuICAgICAgICAgICAgbWVzc2FnZUlkOiAnZGVmYXVsdCcsXG4gICAgICAgICAgICBmb3JtYXQ6IHsgdGFyZ2V0OiBgTW9kZWwgJyR7bW9kZWwubmFtZX0nYCB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH07XG4gIH0sXG59KTtcblxuZXhwb3J0IGNvbnN0IHJlcXVpcmVLZXkgPSBjcmVhdGVSdWxlKHtcbiAgbmFtZTogJ3JlcXVpcmUta2V5JyxcbiAgZGVzY3JpcHRpb246ICdFYWNoIG1vZGVsIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgQGtleSBwcm9wZXJ0eScsXG4gIHNldmVyaXR5OiAnd2FybmluZycsXG4gIG1lc3NhZ2VzOiB7XG4gICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYE1vZGVsICckeydtb2RlbCd9JyBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHByb3BlcnR5IG1hcmtlZCB3aXRoIEBrZXlgLFxuICB9LFxuICBjcmVhdGUoY29udGV4dCkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlbDogKG1vZGVsOiBNb2RlbCkgPT4ge1xuICAgICAgICBsZXQgaGFzS2V5ID0gZmFsc2U7XG4gICAgICAgIGZvciAoY29uc3QgWywgcHJvcF0gb2YgbW9kZWwucHJvcGVydGllcykge1xuICAgICAgICAgIGlmIChpc0tleShjb250ZXh0LnByb2dyYW0sIHByb3ApKSB7XG4gICAgICAgICAgICBoYXNLZXkgPSB0cnVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmICghaGFzS2V5ICYmIG1vZGVsLnByb3BlcnRpZXMuc2l6ZSA+IDApIHtcbiAgICAgICAgICBjb250ZXh0LnJlcG9ydERpYWdub3N0aWMoe1xuICAgICAgICAgICAgdGFyZ2V0OiBtb2RlbCxcbiAgICAgICAgICAgIG1lc3NhZ2VJZDogJ2RlZmF1bHQnLFxuICAgICAgICAgICAgZm9ybWF0OiB7IG1vZGVsOiBtb2RlbC5uYW1lIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfTtcbiAgfSxcbn0pO1xuXG5leHBvcnQgY29uc3QgcGlpUmVxdWlyZXNBbm9ueW1pemF0aW9uID0gY3JlYXRlUnVsZSh7XG4gIG5hbWU6ICdwaWktcmVxdWlyZXMtYW5vbnltaXphdGlvbicsXG4gIGRlc2NyaXB0aW9uOiAnUElJIHByb3BlcnRpZXMgbXVzdCBoYXZlIGFub255bWl6YXRpb24gc3RyYXRlZ3kgc3BlY2lmaWVkJyxcbiAgLy8gUnVsZS1sZXZlbCBzZXZlcml0eSBpcyBzdHJ1Y3R1cmFsbHkgXCJ3YXJuaW5nXCItb25seSBpbiB0aGlzIGNvbXBpbGVyXG4gIC8vIHZlcnNpb247IHRoZSByZWFsIGVycm9yIHNldmVyaXR5IGlzIG9uIHRoZSAncGlpLXJlcXVpcmVzLWFub255bWl6YXRpb24nXG4gIC8vIGRpYWdub3N0aWMgY29kZSAobGliLnRzIC8gaW5kZXgudHMpLCB3aGljaCByZXBvcnREaWFnbm9zdGljIHVzZXMuXG4gIHNldmVyaXR5OiAnd2FybmluZycsXG4gIG1lc3NhZ2VzOiB7XG4gICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYFByb3BlcnR5ICckeydwcm9wZXJ0eSd9JyBpcyBtYXJrZWQgYXMgUElJIGJ1dCBoYXMgbm8gQGFub255bWl6YXRpb24gc3RyYXRlZ3lgLFxuICB9LFxuICBjcmVhdGUoY29udGV4dCkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlbFByb3BlcnR5OiAocHJvcGVydHk6IE1vZGVsUHJvcGVydHkpID0+IHtcbiAgICAgICAgaWYgKGlzUGlpKGNvbnRleHQucHJvZ3JhbSwgcHJvcGVydHkpICYmICFnZXRBbm9ueW1pemF0aW9uKGNvbnRleHQucHJvZ3JhbSwgcHJvcGVydHkpKSB7XG4gICAgICAgICAgY29udGV4dC5yZXBvcnREaWFnbm9zdGljKHtcbiAgICAgICAgICAgIHRhcmdldDogcHJvcGVydHksXG4gICAgICAgICAgICBtZXNzYWdlSWQ6ICdkZWZhdWx0JyxcbiAgICAgICAgICAgIGZvcm1hdDogeyBwcm9wZXJ0eTogcHJvcGVydHkubmFtZSB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH07XG4gIH0sXG59KTtcblxuZXhwb3J0IGNvbnN0IHBpaVJlcXVpcmVzUmVzdHJpY3RlZENsYXNzaWZpY2F0aW9uID0gY3JlYXRlUnVsZSh7XG4gIG5hbWU6ICdwaWktcmVxdWlyZXMtcmVzdHJpY3RlZC1jbGFzc2lmaWNhdGlvbicsXG4gIGRlc2NyaXB0aW9uOiAnUElJIHByb3BlcnRpZXMgbXVzdCBoYXZlIFJlc3RyaWN0ZWQsIENvbmZpZGVudGlhbCwgb3IgUElJIGNsYXNzaWZpY2F0aW9uJyxcbiAgc2V2ZXJpdHk6ICd3YXJuaW5nJyxcbiAgbWVzc2FnZXM6IHtcbiAgICBkZWZhdWx0OiBwYXJhbU1lc3NhZ2VgUHJvcGVydHkgJyR7J3Byb3BlcnR5J30nIGlzIG1hcmtlZCBhcyBQSUkgYnV0IGhhcyBjbGFzc2lmaWNhdGlvbiAnJHsnY2xhc3NpZmljYXRpb24nfScgKG11c3QgYmUgUmVzdHJpY3RlZCwgQ29uZmlkZW50aWFsLCBvciBQSUkpYCxcbiAgfSxcbiAgY3JlYXRlKGNvbnRleHQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZWxQcm9wZXJ0eTogKHByb3BlcnR5OiBNb2RlbFByb3BlcnR5KSA9PiB7XG4gICAgICAgIGlmIChpc1BpaShjb250ZXh0LnByb2dyYW0sIHByb3BlcnR5KSkge1xuICAgICAgICAgIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gZ2V0RGF0YUNsYXNzaWZpY2F0aW9uKGNvbnRleHQucHJvZ3JhbSwgcHJvcGVydHkpO1xuICAgICAgICAgIGNvbnN0IHZhbGlkQ2xhc3NpZmljYXRpb25zID0gWydSZXN0cmljdGVkJywgJ0NvbmZpZGVudGlhbCcsICdQSUknXTtcbiAgICAgICAgICBpZiAoY2xhc3NpZmljYXRpb24gJiYgIXZhbGlkQ2xhc3NpZmljYXRpb25zLmluY2x1ZGVzKGNsYXNzaWZpY2F0aW9uKSkge1xuICAgICAgICAgICAgY29udGV4dC5yZXBvcnREaWFnbm9zdGljKHtcbiAgICAgICAgICAgICAgdGFyZ2V0OiBwcm9wZXJ0eSxcbiAgICAgICAgICAgICAgbWVzc2FnZUlkOiAnZGVmYXVsdCcsXG4gICAgICAgICAgICAgIGZvcm1hdDogeyBwcm9wZXJ0eTogcHJvcGVydHkubmFtZSwgY2xhc3NpZmljYXRpb24gfSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9O1xuICB9LFxufSk7XG5cbmV4cG9ydCBjb25zdCBkZWNpbWFsUmVxdWlyZXNQcmVjaXNpb24gPSBjcmVhdGVSdWxlKHtcbiAgbmFtZTogJ2RlY2ltYWwtcmVxdWlyZXMtcHJlY2lzaW9uJyxcbiAgZGVzY3JpcHRpb246ICdEZWNpbWFsL251bWVyaWMgZmllbGRzIG11c3QgaGF2ZSBAcHJlY2lzaW9uIHNwZWNpZmllZCcsXG4gIHNldmVyaXR5OiAnd2FybmluZycsXG4gIG1lc3NhZ2VzOiB7XG4gICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYFByb3BlcnR5ICckeydwcm9wZXJ0eSd9JyBhcHBlYXJzIHRvIGJlIGRlY2ltYWwvbnVtZXJpYyBidXQgaGFzIG5vIEBwcmVjaXNpb24gc3BlY2lmaWVkYCxcbiAgfSxcbiAgY3JlYXRlKGNvbnRleHQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZWxQcm9wZXJ0eTogKHByb3BlcnR5OiBNb2RlbFByb3BlcnR5KSA9PiB7XG4gICAgICAgIGNvbnN0IHR5cGUgPSBwcm9wZXJ0eS50eXBlO1xuICAgICAgICBpZiAodHlwZS5raW5kID09PSAnU2NhbGFyJykge1xuICAgICAgICAgIGNvbnN0IHNjYWxhck5hbWUgPSB0eXBlLm5hbWUudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICBpZiAoWydkZWNpbWFsJywgJ2RlY2ltYWwxMjgnLCAnZmxvYXQnLCAnZmxvYXQ2NCcsICdudW1lcmljJ10uaW5jbHVkZXMoc2NhbGFyTmFtZSkpIHtcbiAgICAgICAgICAgIGlmICghZ2V0UHJlY2lzaW9uKGNvbnRleHQucHJvZ3JhbSwgcHJvcGVydHkpKSB7XG4gICAgICAgICAgICAgIGNvbnRleHQucmVwb3J0RGlhZ25vc3RpYyh7XG4gICAgICAgICAgICAgICAgdGFyZ2V0OiBwcm9wZXJ0eSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlSWQ6ICdkZWZhdWx0JyxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6IHsgcHJvcGVydHk6IHByb3BlcnR5Lm5hbWUgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIH07XG4gIH0sXG59KTtcblxuZXhwb3J0IGNvbnN0IGF2cm9GaXhlZFJlcXVpcmVzU2l6ZSA9IGNyZWF0ZVJ1bGUoe1xuICBuYW1lOiAnYXZyby1maXhlZC1yZXF1aXJlcy1zaXplJyxcbiAgZGVzY3JpcHRpb246ICdAYXZyb0xvZ2ljYWxUeXBlKGZpeGVkKSByZXF1aXJlcyBAYXZyb0ZpeGVkU2l6ZScsXG4gIHNldmVyaXR5OiAnd2FybmluZycsXG4gIG1lc3NhZ2VzOiB7XG4gICAgZGVmYXVsdDogcGFyYW1NZXNzYWdlYFByb3BlcnR5ICckeydwcm9wZXJ0eSd9JyBoYXMgQGF2cm9Mb2dpY2FsVHlwZShmaXhlZCkgYnV0IG5vIEBhdnJvRml4ZWRTaXplYCxcbiAgfSxcbiAgY3JlYXRlKGNvbnRleHQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZWxQcm9wZXJ0eTogKHByb3BlcnR5OiBNb2RlbFByb3BlcnR5KSA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBnZXRBdnJvTG9naWNhbFR5cGUoY29udGV4dC5wcm9ncmFtLCBwcm9wZXJ0eSkgPT09ICdmaXhlZCcgJiZcbiAgICAgICAgICBnZXRBdnJvRml4ZWRTaXplKGNvbnRleHQucHJvZ3JhbSwgcHJvcGVydHkpID09PSB1bmRlZmluZWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29udGV4dC5yZXBvcnREaWFnbm9zdGljKHtcbiAgICAgICAgICAgIHRhcmdldDogcHJvcGVydHksXG4gICAgICAgICAgICBtZXNzYWdlSWQ6ICdkZWZhdWx0JyxcbiAgICAgICAgICAgIGZvcm1hdDogeyBwcm9wZXJ0eTogcHJvcGVydHkubmFtZSB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH07XG4gIH0sXG59KTtcblxuZXhwb3J0IGNvbnN0IHByb3RvYnVmTm9EdXBsaWNhdGVGaWVsZE51bWJlcnMgPSBjcmVhdGVSdWxlKHtcbiAgbmFtZTogJ3Byb3RvYnVmLW5vLWR1cGxpY2F0ZS1maWVsZC1udW1iZXJzJyxcbiAgZGVzY3JpcHRpb246ICdQcm90b2J1ZiBmaWVsZCBudW1iZXJzIG11c3QgYmUgdW5pcXVlIHdpdGhpbiBhIG1vZGVsJyxcbiAgc2V2ZXJpdHk6ICd3YXJuaW5nJyxcbiAgbWVzc2FnZXM6IHtcbiAgICBkZWZhdWx0OiBwYXJhbU1lc3NhZ2VgTW9kZWwgJyR7J21vZGVsJ30nIGhhcyBkdXBsaWNhdGUgQHByb3RvYnVmRmllbGROdW1iZXIgdmFsdWUgJHsnbnVtYmVyJ30gb24gcHJvcGVydGllcyAnJHsnZmlyc3QnfScgYW5kICckeydzZWNvbmQnfSdgLFxuICB9LFxuICBjcmVhdGUoY29udGV4dCkge1xuICAgIHJldHVybiB7XG4gICAgICBtb2RlbDogKG1vZGVsOiBNb2RlbCkgPT4ge1xuICAgICAgICBjb25zdCBzZWVuID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZz4oKTtcbiAgICAgICAgZm9yIChjb25zdCBbLCBwcm9wXSBvZiBtb2RlbC5wcm9wZXJ0aWVzKSB7XG4gICAgICAgICAgY29uc3QgbnVtID0gZ2V0UHJvdG9idWZGaWVsZE51bWJlcihjb250ZXh0LnByb2dyYW0sIHByb3ApO1xuICAgICAgICAgIGlmIChudW0gPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBzZWVuLmdldChudW0pO1xuICAgICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yZXBvcnREaWFnbm9zdGljKHtcbiAgICAgICAgICAgICAgdGFyZ2V0OiBwcm9wLFxuICAgICAgICAgICAgICBtZXNzYWdlSWQ6ICdkZWZhdWx0JyxcbiAgICAgICAgICAgICAgZm9ybWF0OiB7IG1vZGVsOiBtb2RlbC5uYW1lLCBudW1iZXI6IFN0cmluZyhudW0pLCBmaXJzdDogZXhpc3RpbmcsIHNlY29uZDogcHJvcC5uYW1lIH0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2Vlbi5zZXQobnVtLCBwcm9wLm5hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9O1xuICB9LFxufSk7XG5cbmV4cG9ydCBjb25zdCBhbGxSdWxlcyA9IFtcbiAgcmVxdWlyZURvY3VtZW50YXRpb24sXG4gIHJlcXVpcmVDbGFzc2lmaWNhdGlvbixcbiAgcmVxdWlyZUtleSxcbiAgcGlpUmVxdWlyZXNBbm9ueW1pemF0aW9uLFxuICBwaWlSZXF1aXJlc1Jlc3RyaWN0ZWRDbGFzc2lmaWNhdGlvbixcbiAgZGVjaW1hbFJlcXVpcmVzUHJlY2lzaW9uLFxuICBhdnJvRml4ZWRSZXF1aXJlc1NpemUsXG4gIHByb3RvYnVmTm9EdXBsaWNhdGVGaWVsZE51bWJlcnMsXG5dO1xuIl19