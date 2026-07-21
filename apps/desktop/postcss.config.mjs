import prefixSelector from "postcss-prefix-selector";

const markdownScope = ".kmuxMarkdownSurface";

export default {
  plugins: [
    prefixSelector({
      prefix: markdownScope,
      includeFiles: [
        /MarkdownSurface\.css$/u,
        /streamdown[/\\]styles\.css$/u,
        /katex[/\\]dist[/\\]katex\.min\.css$/u
      ],
      transform(prefix, selector, prefixedSelector) {
        if (selector.includes(prefix)) return selector;
        if (/^(?::root|html|body)(?:\b|\s|$)/u.test(selector)) {
          return selector.replace(/^(?::root|html|body)/u, prefix);
        }
        return prefixedSelector;
      }
    })
  ]
};
