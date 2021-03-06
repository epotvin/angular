import {
  isPresent,
  isBlank,
  StringWrapper,
  stringify,
  assertionsEnabled,
  StringJoiner,
  serializeEnum,
  CONST_EXPR
} from 'angular2/src/facade/lang';

import {ListWrapper} from 'angular2/src/facade/collection';

import {HtmlAst, HtmlAttrAst, HtmlTextAst, HtmlElementAst} from './html_ast';

import {Injectable} from 'angular2/src/core/di';
import {HtmlToken, HtmlTokenType, tokenizeHtml} from './html_lexer';
import {ParseError, ParseLocation, ParseSourceSpan} from './parse_util';
import {HtmlTagDefinition, getHtmlTagDefinition, getHtmlTagNamespacePrefix} from './html_tags';

export class HtmlTreeError extends ParseError {
  static create(elementName: string, location: ParseLocation, msg: string): HtmlTreeError {
    return new HtmlTreeError(elementName, location, msg);
  }

  constructor(public elementName: string, location: ParseLocation, msg: string) {
    super(location, msg);
  }
}

export class HtmlParseTreeResult {
  constructor(public rootNodes: HtmlAst[], public errors: ParseError[]) {}
}

@Injectable()
export class HtmlParser {
  parse(sourceContent: string, sourceUrl: string): HtmlParseTreeResult {
    var tokensAndErrors = tokenizeHtml(sourceContent, sourceUrl);
    var treeAndErrors = new TreeBuilder(tokensAndErrors.tokens).build();
    return new HtmlParseTreeResult(treeAndErrors.rootNodes, (<ParseError[]>tokensAndErrors.errors)
                                                                .concat(treeAndErrors.errors));
  }
}

class TreeBuilder {
  private index: number = -1;
  private peek: HtmlToken;

  private rootNodes: HtmlAst[] = [];
  private errors: HtmlTreeError[] = [];

  private elementStack: HtmlElementAst[] = [];

  constructor(private tokens: HtmlToken[]) { this._advance(); }

  build(): HtmlParseTreeResult {
    while (this.peek.type !== HtmlTokenType.EOF) {
      if (this.peek.type === HtmlTokenType.TAG_OPEN_START) {
        this._consumeStartTag(this._advance());
      } else if (this.peek.type === HtmlTokenType.TAG_CLOSE) {
        this._consumeEndTag(this._advance());
      } else if (this.peek.type === HtmlTokenType.CDATA_START) {
        this._closeVoidElement();
        this._consumeCdata(this._advance());
      } else if (this.peek.type === HtmlTokenType.COMMENT_START) {
        this._closeVoidElement();
        this._consumeComment(this._advance());
      } else if (this.peek.type === HtmlTokenType.TEXT ||
                 this.peek.type === HtmlTokenType.RAW_TEXT ||
                 this.peek.type === HtmlTokenType.ESCAPABLE_RAW_TEXT) {
        this._closeVoidElement();
        this._consumeText(this._advance());
      } else {
        // Skip all other tokens...
        this._advance();
      }
    }
    return new HtmlParseTreeResult(this.rootNodes, this.errors);
  }

  private _advance(): HtmlToken {
    var prev = this.peek;
    if (this.index < this.tokens.length - 1) {
      // Note: there is always an EOF token at the end
      this.index++;
    }
    this.peek = this.tokens[this.index];
    return prev;
  }

  private _advanceIf(type: HtmlTokenType): HtmlToken {
    if (this.peek.type === type) {
      return this._advance();
    }
    return null;
  }

  private _consumeCdata(startToken: HtmlToken) {
    this._consumeText(this._advance());
    this._advanceIf(HtmlTokenType.CDATA_END);
  }

  private _consumeComment(startToken: HtmlToken) {
    this._advanceIf(HtmlTokenType.RAW_TEXT);
    this._advanceIf(HtmlTokenType.COMMENT_END);
  }

  private _consumeText(token: HtmlToken) {
    let text = token.parts[0];
    if (text.length > 0 && text[0] == '\n') {
      let parent = this._getParentElement();
      if (isPresent(parent) && parent.children.length == 0 &&
          getHtmlTagDefinition(parent.name).ignoreFirstLf) {
        text = text.substring(1);
      }
    }

    if (text.length > 0) {
      this._addToParent(new HtmlTextAst(text, token.sourceSpan));
    }
  }

  private _closeVoidElement(): void {
    if (this.elementStack.length > 0) {
      let el = ListWrapper.last(this.elementStack);

      if (getHtmlTagDefinition(el.name).isVoid) {
        this.elementStack.pop();
      }
    }
  }

  private _consumeStartTag(startTagToken: HtmlToken) {
    var prefix = startTagToken.parts[0];
    var name = startTagToken.parts[1];
    var attrs = [];
    while (this.peek.type === HtmlTokenType.ATTR_NAME) {
      attrs.push(this._consumeAttr(this._advance()));
    }
    var fullName = getElementFullName(prefix, name, this._getParentElement());
    var selfClosing = false;
    // Note: There could have been a tokenizer error
    // so that we don't get a token for the end tag...
    if (this.peek.type === HtmlTokenType.TAG_OPEN_END_VOID) {
      this._advance();
      selfClosing = true;
      if (getHtmlTagNamespacePrefix(fullName) == null && !getHtmlTagDefinition(fullName).isVoid) {
        this.errors.push(HtmlTreeError.create(
            fullName, startTagToken.sourceSpan.start,
            `Only void and foreign elements can be self closed "${startTagToken.parts[1]}"`));
      }
    } else if (this.peek.type === HtmlTokenType.TAG_OPEN_END) {
      this._advance();
      selfClosing = false;
    }
    var end = this.peek.sourceSpan.start;
    var el = new HtmlElementAst(fullName, attrs, [],
                                new ParseSourceSpan(startTagToken.sourceSpan.start, end));
    this._pushElement(el);
    if (selfClosing) {
      this._popElement(fullName);
    }
  }

  private _pushElement(el: HtmlElementAst) {
    if (this.elementStack.length > 0) {
      var parentEl = ListWrapper.last(this.elementStack);
      if (getHtmlTagDefinition(parentEl.name).isClosedByChild(el.name)) {
        this.elementStack.pop();
      }
    }

    var tagDef = getHtmlTagDefinition(el.name);
    var parentEl = this._getParentElement();
    if (tagDef.requireExtraParent(isPresent(parentEl) ? parentEl.name : null)) {
      var newParent = new HtmlElementAst(tagDef.parentToAdd, [], [el], el.sourceSpan);
      this._addToParent(newParent);
      this.elementStack.push(newParent);
      this.elementStack.push(el);
    } else {
      this._addToParent(el);
      this.elementStack.push(el);
    }
  }

  private _consumeEndTag(endTagToken: HtmlToken) {
    var fullName =
        getElementFullName(endTagToken.parts[0], endTagToken.parts[1], this._getParentElement());

    if (getHtmlTagDefinition(fullName).isVoid) {
      this.errors.push(
          HtmlTreeError.create(fullName, endTagToken.sourceSpan.start,
                               `Void elements do not have end tags "${endTagToken.parts[1]}"`));
    } else if (!this._popElement(fullName)) {
      this.errors.push(HtmlTreeError.create(fullName, endTagToken.sourceSpan.start,
                                            `Unexpected closing tag "${endTagToken.parts[1]}"`));
    }
  }

  private _popElement(fullName: string): boolean {
    for (let stackIndex = this.elementStack.length - 1; stackIndex >= 0; stackIndex--) {
      let el = this.elementStack[stackIndex];
      if (el.name.toLowerCase() == fullName.toLowerCase()) {
        ListWrapper.splice(this.elementStack, stackIndex, this.elementStack.length - stackIndex);
        return true;
      }

      if (!getHtmlTagDefinition(el.name).closedByParent) {
        return false;
      }
    }
    return false;
  }

  private _consumeAttr(attrName: HtmlToken): HtmlAttrAst {
    var fullName = mergeNsAndName(attrName.parts[0], attrName.parts[1]);
    var end = attrName.sourceSpan.end;
    var value = '';
    if (this.peek.type === HtmlTokenType.ATTR_VALUE) {
      var valueToken = this._advance();
      value = valueToken.parts[0];
      end = valueToken.sourceSpan.end;
    }
    return new HtmlAttrAst(fullName, value, new ParseSourceSpan(attrName.sourceSpan.start, end));
  }

  private _getParentElement(): HtmlElementAst {
    return this.elementStack.length > 0 ? ListWrapper.last(this.elementStack) : null;
  }

  private _addToParent(node: HtmlAst) {
    var parent = this._getParentElement();
    if (isPresent(parent)) {
      parent.children.push(node);
    } else {
      this.rootNodes.push(node);
    }
  }
}

function mergeNsAndName(prefix: string, localName: string): string {
  return isPresent(prefix) ? `@${prefix}:${localName}` : localName;
}

function getElementFullName(prefix: string, localName: string,
                            parentElement: HtmlElementAst): string {
  if (isBlank(prefix)) {
    prefix = getHtmlTagDefinition(localName).implicitNamespacePrefix;
    if (isBlank(prefix) && isPresent(parentElement)) {
      prefix = getHtmlTagNamespacePrefix(parentElement.name);
    }
  }

  return mergeNsAndName(prefix, localName);
}
