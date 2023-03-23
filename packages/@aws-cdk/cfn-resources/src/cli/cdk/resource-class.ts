import { PropertyType, Resource, TagType } from '@aws-cdk/service-spec';
import {
  $E,
  $T,
  Block,
  ClassType,
  expr,
  Expression,
  MemberVisibility,
  IScope,
  stmt,
  StructType,
  SuperInitializer,
  TruthyOr,
  Type,
} from '@cdklabs/typewriter';
import { Stability } from '@jsii/spec';
import { CDK_CORE, CONSTRUCTS } from './cdk';
import {
  attributePropertyName,
  classNameFromResource,
  cfnParserNameFromType,
  staticResourceTypeName,
  cfnProducerNameFromType,
  propertyNameFromCloudFormation,
} from '../naming/conventions';
import { cloudFormationDocLink } from '../naming/doclink';
import { splitDocumentation } from '../split-summary';

export interface ITypeHost {
  typeFromSpecType(type: PropertyType): Type;
}

export interface ResourceClassSpec {
  propsType: StructType;
}

export class ResourceClass extends ClassType {
  private _propsType?: StructType;

  constructor(scope: IScope, private readonly res: Resource) {
    super(scope, {
      export: true,
      name: classNameFromResource(res),
      docs: {
        ...splitDocumentation(res.documentation),
        stability: Stability.External,
        see: cloudFormationDocLink({
          resourceType: res.cloudFormationType,
        }),
      },
      extends: CDK_CORE.CfnResource,
      implements: [CDK_CORE.IInspectable, ...(res.tagPropertyName !== undefined ? [CDK_CORE.ITaggable] : [])],
    });
  }

  private get propsType(): StructType {
    if (!this._propsType) {
      throw new Error('_propsType must be set before calling this method');
    }
    return this._propsType;
  }

  public buildMembers(propsType: StructType) {
    this._propsType = propsType;

    this.addProperty({
      name: staticResourceTypeName(),
      immutable: true,
      static: true,
      type: Type.STRING,
      initializer: expr.lit(this.res.cloudFormationType),
      docs: {
        summary: 'The CloudFormation resource type name for this resource class.',
      },
    });

    this.addFromCloudFormationFactory(propsType);

    // Attributes
    for (const { attrName, name, type, attr } of this.mappableAttributes()) {
      this.addProperty({
        name,
        type,
        immutable: true,
        docs: {
          summary: attr.documentation,
          remarks: [`@cloudformationAttribute ${attrName}`].join('\n'),
        },
      });
    }

    // Copy properties onto class properties
    for (const { name, prop, memberOptional, memberType } of this.mappableProperties()) {
      this.addProperty({
        name: name,
        type: memberType,
        optional: memberOptional,
        docs: {
          summary: prop.docs?.summary,
        },
      });
    }

    this.makeConstructor();
    this.makeInspectMethod();
    this.makeCfnProperties();
    this.makeRenderProperties();
  }

  private addFromCloudFormationFactory(propsType: StructType) {
    const factory = this.addMethod({
      name: '_fromCloudFormation',
      returnType: this.type,
      docs: {
        summary: `Build a ${this.name} from CloudFormation properties`,
        remarks: [
          'A factory method that creates a new instance of this class from an object',
          'containing the CloudFormation properties of this resource.',
          'Used in the @aws-cdk/cloudformation-include module.',
          '',
          '@internal',
        ].join('\n'),
      },
    });

    const scope = factory.addParameter({ name: 'scope', type: CONSTRUCTS.Construct });
    const id = factory.addParameter({ name: 'id', type: Type.STRING });
    const resourceAttributes = $E(factory.addParameter({ name: 'resourceAttributes', type: Type.ANY }));
    const options = $E(
      factory.addParameter({
        name: 'options',
        type: CDK_CORE.helpers.FromCloudFormationOptions,
      }),
    );

    const resourceProperties = expr.ident('resourceProperties');
    const propsResult = $E(expr.ident('propsResult'));
    const ret = $E(expr.ident('ret'));

    const reverseMapper = expr.ident(cfnParserNameFromType(propsType));

    factory.addBody(
      stmt.assign(resourceAttributes, new TruthyOr(resourceAttributes, expr.lit({}))),
      stmt.constVar(resourceProperties, options.parser.parseValue(resourceAttributes.Properties)),
      stmt.constVar(propsResult, reverseMapper.call(resourceProperties)),
      stmt.constVar(ret, this.newInstance(scope, id, propsResult.value)),
    );

    const propKey = expr.ident('propKey');
    const propVal = expr.ident('propVal');
    factory.addBody(
      stmt
        .forConst(expr.destructuringArray(propKey, propVal))
        .in(expr.builtInFn('Object.entries', propsResult.extraProperties))
        .do(Block.with(stmt.expr(ret.addPropertyOverride(propKey, propVal)))),

      options.parser.handleAttributes(ret, resourceAttributes, id),
      stmt.ret(ret),
    );
  }

  private makeConstructor() {
    // Ctor
    const init = this.addInitializer({
      docs: {
        summary: `Create a new \`${this.res.cloudFormationType}\`.`,
      },
    });
    const _scope = init.addParameter({
      name: 'scope',
      type: CONSTRUCTS.Construct,
      documentation: 'Scope in which this resource is defined',
    });
    const id = init.addParameter({
      name: 'id',
      type: Type.STRING,
      documentation: 'Construct identifier for this resource (unique in its scope)',
    });
    const props = init.addParameter({
      name: 'props',
      type: this.propsType.type,
      documentation: 'Resource properties',
    });

    const $this = $E(expr.this_());

    init.addBody(
      new SuperInitializer(
        _scope,
        id,
        expr.object({
          type: $T(this.type)[staticResourceTypeName()],
          properties: props,
        }),
      ),

      stmt.sep(),

      // Validate required properties
      ...this.mappableProperties()
        .filter(({ prop }) => !prop.optional)
        .map(({ name }) => CDK_CORE.requireProperty(props, expr.lit(name), $this)),

      stmt.sep(),
    );

    init.addBody(
      // Attributes
      ...this.mappableAttributes().map(({ name, tokenizer }) => stmt.assign($this[name], tokenizer)),

      // Props
      ...this.mappableProperties().map(({ name, initializer }) => stmt.assign($this[name], initializer(props))),
    );
  }

  private makeInspectMethod() {
    const inspect = this.addMethod({
      name: 'inspect',
      docs: {
        summary: 'Examines the CloudFormation resource and discloses attributes',
      },
    });
    const $inspector = $E(
      inspect.addParameter({
        name: 'inspector',
        type: CDK_CORE.TreeInspector,
        documentation: 'tree inspector to collect and process attributes',
      }),
    );
    inspect.addBody(
      $inspector.addAttribute(
        expr.lit('aws:cdk:cloudformation:type'),
        $E(expr.sym(this.symbol))[staticResourceTypeName()],
      ),
      $inspector.addAttribute(expr.lit('aws:cdk:cloudformation:props'), $E(expr.this_()).cfnProperties),
    );
  }

  /**
   * Make the cfnProperties getter
   *
   * This produces a set of properties that are going to be passed into renderProperties().
   */
  private makeCfnProperties() {
    this.addProperty({
      name: 'cfnProperties',
      type: Type.mapOf(Type.ANY),
      protected: true,
      getterBody: Block.with(
        stmt.ret(
          expr.object(
            Object.fromEntries(this.mappableProperties().map(({ name, valueToRender }) => [name, valueToRender])),
          ),
        ),
      ),
    });
  }

  /**
   * Make the renderProperties() method
   *
   * This forwards straight to the props type mapper
   */
  private makeRenderProperties() {
    const m = this.addMethod({
      name: 'renderProperties',
      returnType: Type.mapOf(Type.ANY),
      visibility: MemberVisibility.Protected,
    });
    const props = m.addParameter({
      name: 'props',
      type: Type.mapOf(Type.ANY),
    });
    m.addBody(stmt.ret($E(expr.ident(cfnProducerNameFromType(this.propsType)))(props)));
  }

  private mappableAttributes() {
    const $this = $E(expr.this_());
    const $ResolutionTypeHint = $T(CDK_CORE.ResolutionTypeHint);

    return Object.entries(this.res.attributes).flatMap(([attrName, attr]) => {
      let type: Type | undefined;
      let tokenizer: Expression = expr.ident('<dummy>');

      if (attr.type.type === 'string') {
        type = Type.STRING;
        tokenizer = CDK_CORE.tokenAsString($this.getAtt(expr.lit(attrName), $ResolutionTypeHint.STRING));
      } else if (attr.type.type === 'number') {
        type = Type.NUMBER;
        tokenizer = CDK_CORE.tokenAsNumber($this.getAtt(expr.lit(attrName), $ResolutionTypeHint.NUMBER));
      } else if (attr.type.type === 'array' && attr.type.element.type === 'string') {
        type = Type.arrayOf(Type.STRING);
        tokenizer = CDK_CORE.tokenAsList($this.getAtt(expr.lit(attrName), $ResolutionTypeHint.STRING_LIST));
      }

      return type ? [{ attrName, attr, name: attributePropertyName(attrName), type, tokenizer }] : [];
    });
  }

  private mappableProperties() {
    const $this = $E(expr.this_());
    return this.propsType.properties.map((prop) => {
      // FIXME: Would be nicer to thread this value through
      const isTagType = prop.name === propertyNameFromCloudFormation(this.res.tagPropertyName ?? '');

      if (isTagType) {
        return {
          // The property must be called 'tags' for the resource to count as ITaggable
          name: 'tags',
          prop,
          memberOptional: false,
          memberType: CDK_CORE.TagManager,
          initializer: (props: Expression) =>
            new CDK_CORE.TagManager(
              translateTagType(this.res.tagType ?? 'standard'),
              expr.lit(this.res.cloudFormationType),
              prop.from(props),
              expr.object({ tagPropertyName: expr.lit(prop.name) }),
            ),
          valueToRender: $this.tags.renderTags(),
        };
      }

      return {
        name: prop.name,
        prop,
        memberOptional: prop.optional,
        memberType: prop.type,
        initializer: (props: Expression) => prop.from(props),
        valueToRender: $this[prop.name],
      };
    });
  }
}

function translateTagType(x: TagType) {
  switch (x) {
    case 'standard':
      return CDK_CORE.TagType.STANDARD;
    case 'asg':
      return CDK_CORE.TagType.AUTOSCALING_GROUP;
    case 'map':
      return CDK_CORE.TagType.MAP;
  }
}