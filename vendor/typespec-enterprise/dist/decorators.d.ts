import { DecoratorContext, Model, ModelProperty, Program, Type } from '@typespec/compiler';
export type DataClassificationValue = 'Public' | 'Internal' | 'PII' | 'FINANCIAL' | 'Confidential' | 'Restricted';
export type AnonymizationStrategyValue = 'hash' | 'tokenize' | 'mask' | 'none';
export interface PrecisionInfo {
    precision: number;
    scale: number;
}
export interface SourceMappingInfo {
    system: string;
    entity: string;
    field?: string;
    transform?: string;
}
export type AvroLogicalTypeValue = 'decimal' | 'date' | 'timeMillis' | 'timeMicros' | 'timestampMillis' | 'timestampMicros' | 'uuid' | 'duration' | 'fixed';
export type AvroFieldOrderValue = 'ascending' | 'descending' | 'ignore';
export interface DeprecationInfo {
    since: string;
    replacement?: string;
}
export declare function $dataClassification(context: DecoratorContext, target: Model | ModelProperty, level: Type): void;
export declare function $pii(context: DecoratorContext, target: ModelProperty): void;
export declare function $businessOwner(context: DecoratorContext, target: Model, owner: string): void;
export declare function $steward(context: DecoratorContext, target: Model, steward: string): void;
export declare function $retentionPolicy(context: DecoratorContext, target: Model | ModelProperty, policy: string): void;
export declare function $anonymization(context: DecoratorContext, target: ModelProperty, strategy: Type): void;
export declare function $qualityRule(context: DecoratorContext, target: ModelProperty, rule: string): void;
export declare function $precision(context: DecoratorContext, target: ModelProperty, precision: number, scale: number): void;
export declare function $sourceMapping(context: DecoratorContext, target: ModelProperty, system: string, entity: string, field?: string, transform?: string): void;
export declare function $avroLogicalType(context: DecoratorContext, target: ModelProperty, logicalType: Type): void;
export declare function $avroFixedSize(context: DecoratorContext, target: ModelProperty, size: number): void;
export declare function $avroOrder(context: DecoratorContext, target: ModelProperty, order: Type): void;
export declare function $avroNamespace(context: DecoratorContext, target: Model, ns: string): void;
export declare function $avroRecordAliases(context: DecoratorContext, target: Model, aliases: string[]): void;
export declare function $protobufFieldNumber(context: DecoratorContext, target: ModelProperty, number: number): void;
export declare function $protobufOneofGroup(context: DecoratorContext, target: ModelProperty, group: string): void;
export declare function $partitionHint(context: DecoratorContext, target: ModelProperty): void;
export declare function $indexHint(context: DecoratorContext, target: ModelProperty): void;
export declare function $clusterHint(context: DecoratorContext, target: ModelProperty): void;
export declare function $deprecation(context: DecoratorContext, target: Model | ModelProperty, since: string, replacement?: string): void;
export declare function getDataClassification(program: Program, target: Model | ModelProperty): DataClassificationValue | undefined;
export declare function isPii(program: Program, target: ModelProperty): boolean;
export declare function getBusinessOwner(program: Program, target: Model): string | undefined;
export declare function getSteward(program: Program, target: Model): string | undefined;
export declare function getRetentionPolicy(program: Program, target: Model | ModelProperty): string | undefined;
export declare function getAnonymization(program: Program, target: ModelProperty): AnonymizationStrategyValue | undefined;
export declare function getQualityRule(program: Program, target: ModelProperty): string | undefined;
export declare function getPrecision(program: Program, target: ModelProperty): PrecisionInfo | undefined;
export declare function getSourceMapping(program: Program, target: ModelProperty): SourceMappingInfo | undefined;
export declare function getAvroLogicalType(program: Program, target: ModelProperty): AvroLogicalTypeValue | undefined;
export declare function getAvroFixedSize(program: Program, target: ModelProperty): number | undefined;
export declare function getAvroOrder(program: Program, target: ModelProperty): AvroFieldOrderValue | undefined;
export declare function getAvroNamespace(program: Program, target: Model): string | undefined;
export declare function getAvroRecordAliases(program: Program, target: Model): string[] | undefined;
export declare function getProtobufFieldNumber(program: Program, target: ModelProperty): number | undefined;
export declare function getProtobufOneofGroup(program: Program, target: ModelProperty): string | undefined;
export declare function hasPartitionHint(program: Program, target: ModelProperty): boolean;
export declare function hasIndexHint(program: Program, target: ModelProperty): boolean;
export declare function hasClusterHint(program: Program, target: ModelProperty): boolean;
export declare function getDeprecation(program: Program, target: Model | ModelProperty): DeprecationInfo | undefined;
