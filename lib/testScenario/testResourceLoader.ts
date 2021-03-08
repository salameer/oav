/* eslint-disable require-atomic-updates */
import { join as pathJoin, dirname } from "path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { default as AjvInit, ValidateFunction } from "ajv";
import { inject, injectable } from "inversify";
import { applyPatch, Operation as JsonPatchOperation } from "fast-json-patch";
import { Loader, setDefaultOpts } from "../swagger/loader";
import { FileLoader, FileLoaderOption } from "../swagger/fileLoader";
import { JsonLoader, JsonLoaderOption } from "../swagger/jsonLoader";
import { getTransformContext, TransformContext } from "../transform/context";
import { SchemaValidator } from "../swaggerValidator/schemaValidator";
import { AjvSchemaValidator } from "../swaggerValidator/ajvSchemaValidator";
import { xmsPathsTransformer } from "../transform/xmsPathsTransformer";
import { resolveNestedDefinitionTransformer } from "../transform/resolveNestedDefinitionTransformer";
import { referenceFieldsTransformer } from "../transform/referenceFieldsTransformer";
import { discriminatorTransformer } from "../transform/discriminatorTransformer";
import { allOfTransformer } from "../transform/allOfTransformer";
import { noAdditionalPropertiesTransformer } from "../transform/noAdditionalPropertiesTransformer";
import { nullableTransformer } from "../transform/nullableTransformer";
import { pureObjectTransformer } from "../transform/pureObjectTransformer";
import { SwaggerLoader, SwaggerLoaderOption } from "../swagger/swaggerLoader";
import { applySpecTransformers, applyGlobalTransformers } from "../transform/transformer";
import { SwaggerSpec, Operation, SwaggerExample } from "../swagger/swaggerTypes";
import { traverseSwagger } from "../transform/traverseSwagger";
import { inversifyGetInstance, TYPES } from "../inversifyUtils";
import {
  TestDefinitionSchema,
  TestDefinitionFile,
  TestScenario,
  TestStep,
  TestStepRestCall,
  TestStepArmTemplateDeployment,
  RawTestDefinitionFile,
  RawTestStepArmTemplateDeployment,
  RawTestStep,
  RawTestStepRestCall,
  RawTestScenario,
  JsonPatchOp,
} from "./testResourceTypes";
import { ExampleTemplateGenerator } from "./exampleTemplateGenerator";
import { BodyTransformer } from "./bodyTransformer";

const ajv = new AjvInit({
  useDefaults: true,
});

export interface TestResourceLoaderOption
  extends FileLoaderOption,
    JsonLoaderOption,
    SwaggerLoaderOption {
  swaggerFilePaths?: string[];
}

interface TestScenarioContext {
  stepTracking: Map<string, TestStep>;
  entityTracking: Map<string, SwaggerExample[]>;
  testDef: TestDefinitionFile;
  testScenario?: TestScenario;
}

@injectable()
export class TestResourceLoader implements Loader<TestDefinitionFile> {
  private transformContext: TransformContext;
  private schemaValidator: SchemaValidator;
  private validateTestResourceFile: ValidateFunction;
  private exampleToOperation: Map<
    string,
    { [operationId: string]: [Operation, string] }
  > = new Map();
  private nameToOperation: Map<string, Operation> = new Map();
  private initialized: boolean = false;

  public constructor(
    @inject(TYPES.opts) private opts: TestResourceLoaderOption,
    private fileLoader: FileLoader,
    public jsonLoader: JsonLoader,
    private swaggerLoader: SwaggerLoader,
    private exampleTemplateGenerator: ExampleTemplateGenerator,
    private bodyTransformer: BodyTransformer
  ) {
    setDefaultOpts(opts, {
      swaggerFilePaths: [],
    });

    this.schemaValidator = new AjvSchemaValidator(this.jsonLoader);

    this.transformContext = getTransformContext(this.jsonLoader, this.schemaValidator, [
      xmsPathsTransformer,
      resolveNestedDefinitionTransformer,
      referenceFieldsTransformer,

      discriminatorTransformer,
      allOfTransformer,
      noAdditionalPropertiesTransformer,
      nullableTransformer,
      pureObjectTransformer,
    ]);

    this.validateTestResourceFile = ajv.compile(TestDefinitionSchema);
  }

  public static create(opts: TestResourceLoaderOption) {
    setDefaultOpts(opts, {
      eraseXmsExamples: false,
      eraseDescription: false,
      skipResolveRefKeys: ["x-ms-examples"],
    });
    return inversifyGetInstance(TestResourceLoader, opts);
  }

  public async initialize() {
    if (this.initialized) {
      throw new Error("Already initialized");
    }

    const allSpecs: SwaggerSpec[] = [];
    for (const swaggerFilePath of this.opts.swaggerFilePaths ?? []) {
      const swaggerSpec = await this.swaggerLoader.load(swaggerFilePath);
      allSpecs.push(swaggerSpec);
      applySpecTransformers(swaggerSpec, this.transformContext);
    }
    applyGlobalTransformers(this.transformContext);

    for (const spec of allSpecs) {
      traverseSwagger(spec, {
        onOperation: (operation) => {
          if (operation.operationId === undefined) {
            throw new Error(
              `OperationId is undefined for operation ${operation._method} ${operation._path._pathTemplate}`
            );
          }

          if (this.nameToOperation.has(operation.operationId)) {
            throw new Error(
              `Duplicated operationId ${operation.operationId}: ${
                operation._path._pathTemplate
              }\nConflict with path: ${
                this.nameToOperation.get(operation.operationId)?._path._pathTemplate
              }`
            );
          }
          this.nameToOperation.set(operation.operationId, operation);

          const xMsExamples = operation["x-ms-examples"] ?? {};
          for (const exampleName of Object.keys(xMsExamples)) {
            const example = xMsExamples[exampleName];
            if (typeof example.$ref !== "string") {
              throw new Error(`Example doesn't use $ref: ${exampleName}`);
            }
            const exampleFilePath = this.jsonLoader.getRealPath(example.$ref);
            let opMap = this.exampleToOperation.get(exampleFilePath);
            if (opMap === undefined) {
              opMap = {};
              this.exampleToOperation.set(exampleFilePath, opMap);
            }
            opMap[operation.operationId] = [operation, exampleName];
          }
        },
      });
    }

    this.initialized = true;
  }

  public async writeTestDefinitionFile(filePath: string, testDef: RawTestDefinitionFile) {
    const fileContent = yamlDump(testDef);
    return this.fileLoader.writeFile(filePath, fileContent);
  }

  public async load(filePath: string): Promise<TestDefinitionFile> {
    if (!this.initialized) {
      await this.initialize();
    }

    const fileContent = await this.fileLoader.load(filePath);
    const filePayload = yamlLoad(fileContent);
    if (!this.validateTestResourceFile(filePayload)) {
      const err = this.validateTestResourceFile.errors![0];
      throw new Error(
        `Failed to validate test resource file ${filePath}: ${err.dataPath} ${err.message}`
      );
    }
    const rawTestDef = filePayload as RawTestDefinitionFile;
    const testDef: TestDefinitionFile = {
      scope: rawTestDef.scope ?? "ResourceGroup",
      requiredVariables: rawTestDef.requiredVariables ?? [],
      prepareSteps: [],
      testScenarios: [],
      _filePath: this.fileLoader.relativePath(filePath),
      variables: rawTestDef.variables ?? {},
    };

    if (testDef.scope === "ResourceGroup") {
      const requiredVariables = new Set(testDef.requiredVariables);
      requiredVariables.add("subscriptionId");
      requiredVariables.add("location");
      testDef.requiredVariables = [...requiredVariables];
    }

    const ctx: TestScenarioContext = {
      stepTracking: new Map(),
      entityTracking: new Map(),
      testDef,
    };
    for (const rawStep of rawTestDef.prepareSteps ?? []) {
      const step = await this.loadTestStep(rawStep, ctx);
      step.isScopePrepareStep = true;
      testDef.prepareSteps.push(step);
    }

    for (const rawTestScenario of rawTestDef.testScenarios) {
      const testScenario = await this.loadTestScenario(rawTestScenario, ctx);
      testDef.testScenarios.push(testScenario);
    }

    return testDef;
  }

  private async loadTestScenario(
    rawTestScenario: RawTestScenario,
    ctx: TestScenarioContext
  ): Promise<TestScenario> {
    const resolvedSteps: TestStep[] = [];
    const steps: TestStep[] = [];
    const { testDef } = ctx;

    const requiredVariables = new Set([
      ...(rawTestScenario.requiredVariables ?? []),
      ...testDef.requiredVariables,
    ]);

    for (const step of testDef.prepareSteps) {
      resolvedSteps.push(step);
    }

    const testScenario: TestScenario = {
      description: rawTestScenario.description,
      shareTestScope: rawTestScenario.shareTestScope ?? true,
      variables: rawTestScenario.variables ?? {},
      requiredVariables: [...requiredVariables],
      steps,
      _resolvedSteps: resolvedSteps,
      _testDef: testDef,
    };
    ctx.testScenario = testScenario;

    for (const rawStep of rawTestScenario.steps) {
      const step = await this.loadTestStep(rawStep, ctx);
      resolvedSteps.push(step);
      steps.push(step);
    }

    await this.exampleTemplateGenerator.generateExampleTemplateForTestScenario(testScenario);

    return testScenario;
  }

  private async loadTestStep(step: RawTestStep, ctx: TestScenarioContext): Promise<TestStep> {
    if ("armTemplateDeployment" in step) {
      return this.loadTestStepArmTemplate(step, ctx);
    } else if ("exampleFile" in step || "fromStep" in step) {
      return this.loadTestStepRestCall(step, ctx);
    } else {
      throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
    }
  }

  private async loadTestStepArmTemplate(
    rawStep: RawTestStepArmTemplateDeployment,
    ctx: TestScenarioContext
  ): Promise<TestStepArmTemplateDeployment> {
    const step: TestStepArmTemplateDeployment = {
      type: "armTemplateDeployment",
      variables: rawStep.variables ?? {},
      step: rawStep.step ?? "__step_with_no_name",
      armTemplateDeployment: rawStep.armTemplateDeployment,
      armTemplatePayload: {},
    };
    const { testDef, testScenario } = ctx;

    const filePath = pathJoin(dirname(testDef._filePath), step.armTemplateDeployment);
    const armTemplateContent = await this.fileLoader.load(filePath);
    step.armTemplatePayload = JSON.parse(armTemplateContent);

    const definedParameters = [];
    if (step.armTemplateParameters !== undefined) {
      const armTemplateParametersPath = pathJoin(
        dirname(testDef._filePath),
        step.armTemplateParameters
      );
      const armTemplateParametersContent = await this.fileLoader.load(armTemplateParametersPath);
      step.armTemplateParametersPayload = JSON.parse(armTemplateParametersContent);
      definedParameters.push(...Object.keys(step.armTemplateParametersPayload!.parameters));
    }
    const definedParameterSet = new Set(definedParameters);

    const params = step.armTemplatePayload.parameters;
    if (params !== undefined) {
      for (const paramName of Object.keys(params)) {
        if (definedParameterSet.has(paramName) || params[paramName].defaultValue !== undefined) {
          continue;
        }
        if (params[paramName].type !== "string") {
          throw new Error(
            `Only string type is supported in arm template params, please specify defaultValue or add it in arm template parameter file with armTemplateParameters: ${paramName}`
          );
        }
        if (testScenario !== undefined) {
          testScenario.requiredVariables.push(paramName);
        } else {
          testDef.requiredVariables.push(paramName);
        }
      }
    }

    return step;
  }

  private async loadTestStepRestCall(
    rawStep: RawTestStepRestCall,
    ctx: TestScenarioContext
  ): Promise<TestStepRestCall> {
    if (rawStep.step === undefined) {
      throw new Error(
        `Property "step" as step name is required for restCall step: ${rawStep.exampleFile}`
      );
    }
    if (ctx.entityTracking.has(rawStep.step)) {
      throw new Error(`Duplicated step name: ${rawStep.step}`);
    }

    const step: TestStepRestCall = {
      type: "restCall",
      step: rawStep.step!,
      fromStep: rawStep.fromStep,
      exampleFile: rawStep.exampleFile,
      variables: rawStep.variables ?? {},
      operationId: rawStep.operationId ?? "",
      operation: {} as Operation,
      patchRequest: rawStep.patchRequest ?? [],
      patchResponse: rawStep.patchResponse ?? [],
      requestParameters: {} as SwaggerExample["parameters"],
      responseExpected: {},
      exampleId: "",
      statusCode: rawStep.statusCode ?? 200,
    };

    if (rawStep.operationId !== undefined) {
      const operation = this.nameToOperation.get(rawStep.operationId);
      if (operation === undefined) {
        throw new Error(`Operation not found for ${rawStep.operationId}`);
      }
      step.operation = operation;
    }

    if (step.fromStep !== undefined) {
      await this.loadTestStepRestCallFromStep(step, ctx);
    } else {
      await this.loadTestStepRestCallExampleFile(step, ctx);
    }

    try {
      step.requestParameters = applyJsonPatchOp(step.requestParameters, step.patchRequest);
    } catch (e) {
      const err = e as Error;
      err.message = `Failed to apply patchRequest in ${step.step}: ${err.message}`;
    }
    try {
      step.responseExpected = applyJsonPatchOp(step.responseExpected, step.patchResponse);
    } catch (e) {
      const err = e as Error;
      err.message = `Failed to apply patchResponse in ${step.step}: ${err.message}`;
    }

    ctx.stepTracking.set(step.step, step);

    return step;
  }

  private async loadTestStepRestCallFromStep(step: TestStepRestCall, ctx: TestScenarioContext) {
    if (step.exampleFile !== undefined) {
      throw new Error(`Cannot use fromStep along with exampleFile for step: ${step.step}`);
    }
    const fromStep = ctx.stepTracking.get(step.fromStep!);
    if (fromStep === undefined) {
      throw new Error(`Unknown fromStep name: ${step.fromStep}`);
    }
    if (fromStep.type !== "restCall") {
      throw new Error(`Cannot use fromStep from non restCall type for step: ${step.fromStep}`);
    }

    step.requestParameters = fromStep.requestParameters;
    step.responseExpected = fromStep.responseExpected;
    step.exampleId = fromStep.exampleId;
    if (step.operationId === "") {
      step.operationId = fromStep.operationId;
      step.operation = fromStep.operation;
    }

    const convertedRequest = await this.bodyTransformer.responseBodyToRequest(
      fromStep.responseExpected,
      fromStep.operation.responses[fromStep.statusCode].schema!
    );
    const bodyParamName = getBodyParamName(fromStep.operation, this.jsonLoader);
    if (bodyParamName !== undefined) {
      step.requestParameters[bodyParamName] = convertedRequest;
    }
  }

  private async loadTestStepRestCallExampleFile(step: TestStepRestCall, ctx: TestScenarioContext) {
    const filePath = step.exampleFile;
    if (filePath === undefined) {
      throw new Error(`RestCall step must specify "exampleFile" or "fromStep"`);
    }

    const exampleFilePath = pathJoin(dirname(ctx.testDef._filePath), filePath);

    // Load example file
    const fileContent = await this.fileLoader.load(exampleFilePath);
    const exampleFileContent = JSON.parse(fileContent) as SwaggerExample;

    step.requestParameters = exampleFileContent.parameters;
    step.responseExpected = exampleFileContent.responses[step.statusCode];
    if (step.responseExpected === undefined) {
      throw new Error(`Response code ${step.statusCode} not defined in example ${exampleFilePath}`);
    }

    // Load Operation
    if (step.operationId === "") {
      const opMap = this.exampleToOperation.get(exampleFilePath);
      if (opMap === undefined) {
        throw new Error(`Example file is not referenced by any operation: ${filePath}`);
      }
      const ops = Object.values(opMap);
      if (ops.length > 1) {
        throw new Error(
          `Example file is referenced by multiple operation: ${Object.keys(opMap)} ${filePath}`
        );
      }
      [step.operation, step.exampleId] = ops[0];
      step.operationId = step.operation.operationId!;
    }
  }
}

export const getBodyParamName = (operation: Operation, jsonLoader: JsonLoader) => {
  const bodyParams = operation.parameters?.find(
    (param) => jsonLoader.resolveRefObj(param).in === "body"
  );
  return bodyParams?.name;
};

const jsonOpToJsonPatchOperation = (op: JsonPatchOp): JsonPatchOperation | JsonPatchOperation[] => {
  if ("add" in op) {
    return { op: "add", path: op.add, value: op.value };
  }
  if ("remove" in op) {
    return { op: "remove", path: op.remove };
  }
  if ("replace" in op) {
    return { op: "replace", path: op.replace, value: op.value };
  }
  if ("copy" in op) {
    return { op: "copy", from: op.copy, path: op.path };
  }
  if ("move" in op) {
    return { op: "move", from: op.move, path: op.path };
  }
  if ("test" in op) {
    return { op: "test", path: op.test, value: op.value };
  }
  if ("merge" in op) {
    return Object.keys(op.value).map((key) => ({
      op: "add",
      path: `${op.merge}/${key}`,
      value: op.value[key],
    }));
  }

  throw new Error(`Unknown jsonPatchOp: ${JSON.stringify(op)}`);
};

const applyJsonPatchOp = (data: any, ops: JsonPatchOp[]) => {
  if (ops.length === 0) {
    return data;
  }
  let jsonPatchOps: JsonPatchOperation[] = [];
  for (const op of ops) {
    const o = jsonOpToJsonPatchOperation(op);
    if (Array.isArray(o)) {
      jsonPatchOps = jsonPatchOps.concat(o);
    } else {
      jsonPatchOps.push(o);
    }
  }
  const result = applyPatch(data, jsonPatchOps, undefined, false);
  return result.newDocument;
};
