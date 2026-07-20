export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

export interface OpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly enum?: readonly (boolean | number | string)[];
  readonly example?: unknown;
  readonly description?: string;
  readonly nullable?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly uniqueItems?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly items?: OpenApiSchema;
  readonly additionalProperties?: boolean | OpenApiSchema;
  readonly oneOf?: readonly OpenApiSchema[];
  readonly allOf?: readonly OpenApiSchema[];
}

export interface ContractParameter {
  readonly name: string;
  readonly in: "cookie" | "header" | "path" | "query";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema: OpenApiSchema;
}

export interface OperationContract {
  readonly parameters?: readonly ContractParameter[];
  readonly requestBody?: {
    readonly schema: OpenApiSchema;
    readonly contentType?: string;
    readonly description?: string;
  };
  readonly success: {
    readonly status: string;
    readonly schema?: OpenApiSchema;
    readonly contentType?: string;
    readonly description: string;
    readonly headers?: Readonly<Record<string, { description: string; schema: OpenApiSchema }>>;
  };
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}
