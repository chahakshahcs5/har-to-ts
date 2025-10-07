import fs from "fs";
import path from "path";
import prettier from "prettier";
import { URL } from "url";
// Handle CommonJS modules
const jsonToTS = require("json-to-ts");

export interface HarFile {
  log: {
    entries: HarEntry[];
  };
}

export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    postData?: {
      text?: string;
      mimeType?: string;
    };
  };
  response: {
    content?: {
      text?: string;
      mimeType?: string;
    };
  };
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface GeneratorOptions {
  prettierConfig?: prettier.Options;
  skipValidation?: boolean;
  mergeTypes?: boolean;
  typePrefix?: string;
}

function hashType(content: string): string {
  let hash = 0;
  const normalizedContent = content
    .replace(/\s+/g, " ")
    .replace(/interface\s+\w+\s+/g, "interface ")
    .trim();

  for (let i = 0; i < normalizedContent.length; i++) {
    const char = normalizedContent.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function normalizeTypeName(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function getResourceName(url: URL): string {
  const pathParts = url.pathname.split("/").filter(Boolean);
  return pathParts[pathParts.length - 1] || "root";
}

function createFunctionName(url: string, method: string): string {
  let clean = url.replace(/^https?:\/\//, "").split(/[?#]/)[0];
  clean = clean.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
  clean = clean.slice(0, 80);
  return `${method.toLowerCase()}_${clean}`;
}

interface TypeEntry {
  name: string;
  definition: string;
  hash: string;
}

function validateHarFile(har: unknown): void {
  if (!har || typeof har !== "object") {
    throw new Error("Invalid HAR file: Root must be an object");
  }

  const harObj = har as { log?: unknown };
  if (!harObj.log || typeof harObj.log !== "object") {
    throw new Error('Invalid HAR file: Missing or invalid "log" property');
  }

  const logObj = harObj.log as { entries?: unknown };
  if (!logObj.entries || !Array.isArray(logObj.entries)) {
    throw new Error('Invalid HAR file: Missing or invalid "entries" array');
  }
}

// Keep track of normalized property names to ensure uniqueness
const propertyRegistry = new Map<string, string>();

function normalizePropertyName(name: string): string {
  // Remove prefixes and normalize
  let normalizedName = name.replace(/^(ep\.|epn\.|_)/, "");
  normalizedName = normalizedName.replace(/[^a-zA-Z0-9_]/g, "_");

  // Ensure uniqueness
  if (propertyRegistry.has(name)) {
    return propertyRegistry.get(name)!;
  }

  let uniqueName = normalizedName;
  let counter = 1;
  while (Array.from(propertyRegistry.values()).includes(uniqueName)) {
    uniqueName = `${normalizedName}_${counter}`;
    counter++;
  }

  propertyRegistry.set(name, uniqueName);
  return uniqueName;
}

function generateTypeFromFormData(name: string, formData: string): string {
  try {
    const params = new URLSearchParams(formData);
    const properties = new Map<string, string>();

    for (const [key, value] of params.entries()) {
      const propName = normalizePropertyName(key);
      let type = "string";
      if (/^-?\d+$/.test(value)) {
        type = "number";
      } else if (/^true|false$/i.test(value)) {
        type = "boolean";
      }
      properties.set(propName, type);
    }

    return `interface ${name} {\n${Array.from(properties.entries())
      .map(([prop, type]) => `  ${prop}: ${type};`)
      .join("\n")}\n}`;
  } catch (error) {
    console.warn(`⚠️ Failed to generate type for form data ${name}`, error);
    return `type ${name} = Record<string, string>;`;
  }
}

function escapeHeaderValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function generateTypeFromJSON(name: string, data: any): string {
  const options = {
    rootName: name,
    propertyFormatter: normalizePropertyName,
  };

  const types = jsonToTS(data, options);
  const uniqueTypes = new Map<string, string>();

  for (const type of types) {
    const cleanType = type.replace(/\bexport\s+/g, "");
    const hash = hashType(cleanType);
    if (!uniqueTypes.has(hash)) {
      uniqueTypes.set(hash, type.replace(/^interface/, "interface"));
    }
  }

  return Array.from(uniqueTypes.values()).join("\n");
}

function generateTypeFromData(
  name: string,
  data: string | object,
  mimeType?: string
): string {
  try {
    if (mimeType?.includes("application/x-www-form-urlencoded")) {
      if (typeof data !== "string") {
        throw new Error("Form data must be a string");
      }
      return generateTypeFromFormData(name, data);
    }

    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON: not an object");
    }

    return generateTypeFromJSON(name, parsed);
  } catch (error) {
    if (error instanceof SyntaxError && typeof data === "string") {
      try {
        return generateTypeFromFormData(name, data);
      } catch (formError) {
        console.warn(
          `⚠️ Failed to generate type for ${name} as both JSON and form data`,
          error
        );
      }
    }
    console.warn(
      `⚠️ Failed to generate type for ${name}, fallback to 'any'`,
      error
    );
    return `type ${name} = any;`;
  }
}

export async function generateFromHar(
  harPath: string,
  outPath: string,
  options: GeneratorOptions = {}
): Promise<void> {
  try {
    const {
      mergeTypes = true,
      typePrefix = "",
      prettierConfig = {
        parser: "typescript",
        singleQuote: true,
        trailingComma: "es5",
        printWidth: 100,
        tabWidth: 2,
      },
    } = options;

    console.log("🔍 Reading HAR file...");
    const harContent = await fs.promises.readFile(harPath, "utf8");
    const har = JSON.parse(harContent) as HarFile;

    if (!options.skipValidation) {
      validateHarFile(har);
    }

    // Reset property registry for each generation
    propertyRegistry.clear();

    let output = `// Generated TypeScript SDK
// Generated on: ${new Date().toISOString()}

import * as qs from 'qs';

export type RequestInit = Parameters<typeof fetch>[1];
export type RequestInfo = Parameters<typeof fetch>[0];
export type Response = ReturnType<typeof fetch> extends Promise<infer T> ? T : never;

export interface ApiOptions extends Omit<RequestInit, 'body' | 'method'> {
  baseUrl?: string;
  headers?: HeadersInit;
}

export const defaultOptions: ApiOptions = {
  headers: {
    'Content-Type': 'application/json',
  },
};

export interface ResponseBase<T = unknown> {
  data?: T;
}
`;

    const entries = har.log.entries.filter((e) =>
      e.request.url.startsWith("http")
    );
    const typeRegistry = new Map<string, TypeEntry>();

    // Group similar endpoints
    const endpointGroups = new Map<string, HarEntry[]>();
    for (const entry of entries) {
      const url = new URL(entry.request.url);
      const resource = getResourceName(url);
      const key = `${entry.request.method}_${resource}`;
      if (!endpointGroups.has(key)) {
        endpointGroups.set(key, []);
      }
      endpointGroups.get(key)!.push(entry);
    }

    // Process each endpoint group
    for (const [_groupKey, groupEntries] of endpointGroups) {
      const firstEntry = groupEntries[0];
      const { request } = firstEntry;
      const url = new URL(request.url);
      const resource = getResourceName(url);
      const baseTypeName = normalizeTypeName(resource);

      // Generate type names
      const requestTypeName = `${typePrefix}${baseTypeName}Request`;
      const responseTypeName = `${typePrefix}${baseTypeName}Response`;
      const paramsTypeName = `${typePrefix}${baseTypeName}Params`;

      // Generate parameter type
      let paramsType = "{[key: string]: string | number | boolean | undefined}";
      const allQueryParams = new Map<string, Set<string>>();
      for (const entry of groupEntries) {
        const entryUrl = new URL(entry.request.url);
        for (const [key, value] of entryUrl.searchParams.entries()) {
          if (!allQueryParams.has(key)) {
            allQueryParams.set(key, new Set());
          }
          allQueryParams.get(key)!.add(value);
        }
      }

      if (allQueryParams.size) {
        const paramInterface = `interface ${paramsTypeName} {
${Array.from(allQueryParams.entries())
  .map(([key]) => {
    const propName = normalizePropertyName(key);
    return `  ${propName}?: string | number | boolean;`;
  })
  .join("\n")}
}`;
        output += `\nexport ${paramInterface}\n`;
        paramsType = paramsTypeName;
      }

      // Generate request body type
      let bodyType = "undefined";
      for (const entry of groupEntries) {
        if (entry.request.postData?.text) {
          const typeName = `${requestTypeName}${typeRegistry.size || ""}`;
          const definition = generateTypeFromData(
            typeName,
            entry.request.postData.text,
            entry.request.postData.mimeType
          );
          const hash = hashType(definition);

          // Check for existing type with same hash
          let existingType = Array.from(typeRegistry.values()).find(
            (t) => t.hash === hash
          );
          if (!existingType || !mergeTypes) {
            typeRegistry.set(typeName, {
              name: typeName,
              definition,
              hash,
            });
            output += `\nexport ${definition}\n`;
            bodyType = typeName;
          } else {
            bodyType = existingType.name;
          }
        }
      }

      // Generate response type
      let responseType = "ResponseBase<unknown>";
      for (const entry of groupEntries) {
        if (entry.response?.content?.text) {
          try {
            const typeName = `${responseTypeName}${typeRegistry.size || ""}`;
            const definition = generateTypeFromData(
              typeName,
              entry.response.content.text,
              entry.response.content.mimeType
            );
            const hash = hashType(definition);

            // Check for existing type with same hash
            let existingType = Array.from(typeRegistry.values()).find(
              (t) => t.hash === hash
            );
            if (!existingType || !mergeTypes) {
              typeRegistry.set(typeName, {
                name: typeName,
                definition,
                hash,
              });
              output += `\nexport ${definition}\n`;
              responseType = `ResponseBase<${typeName}>`;
            } else {
              responseType = `ResponseBase<${existingType.name}>`;
            }
          } catch (error) {
            console.warn(
              ` Failed to parse response for ${request.url}:`,
              error
            );
          }
        }
      }

      // Generate the function
      output += `
/**
 * ${request.method.toUpperCase()} ${url.pathname}
 */
export async function ${createFunctionName(request.url, request.method)}(
  params?: ${paramsType},
  body?: ${bodyType},
  options: ApiOptions = {}
): Promise<${responseType}> {
  const { baseUrl = '${url.origin}', headers = {}, ...fetchOptions } = { ...defaultOptions, ...options };
  const query = params ? \`?\${qs.stringify(params)}\` : '';
  const requestUrl = \`\${baseUrl}${url.pathname}\${query}\`;

  const response = await fetch(requestUrl, {
    method: '${request.method}',
    headers: {
      ...headers,
      ${request.headers
        .filter((h) => !h.name.startsWith(":"))
        .map((h) => `'${h.name}': '${escapeHeaderValue(h.value)}'`)
        .join(",\n      ")}
    },
    ${bodyType !== "undefined" ? "body: JSON.stringify(body)," : ""}
    ...fetchOptions,
  });

  if (!response.ok) {
    throw new Error(\`HTTP error! status: \${response.status}\`);
  }

  return response.json();
}
`;
    }

    console.log("✨ Formatting generated code...");
    const formatted = await prettier.format(output, prettierConfig);
    await fs.promises.writeFile(outPath, formatted);
    console.log(`✅ Generated SDK  ${outPath}`);
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    throw error;
  }
}

export async function runHarToTs(sourceFile: string, destinationFile: string) {
  console.log("🚀 Starting HAR to TypeScript SDK generation...");
  await generateFromHar(
    path.resolve(process.cwd(), sourceFile),
    path.resolve(process.cwd(), destinationFile),
    {
      typePrefix: "",
      mergeTypes: true,
    }
  );
}