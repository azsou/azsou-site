<?xml version="1.0" encoding="UTF-8"?>
<!-- RSS 浏览器样式页（T9.15）：在浏览器里打开 /rss.xml 时显示品牌化的订阅说明 + 条目列表；阅读器照常解析原始 XML。
     样式在 /rss.css（同源外链，符合站点 CSP，不用内联样式）。 -->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" version="5.0" encoding="UTF-8" indent="yes" />
  <xsl:variable name="en" select="starts-with(/rss/channel/language, 'en')" />
  <xsl:template match="/">
    <html>
      <xsl:attribute name="lang"><xsl:choose><xsl:when test="$en">en</xsl:when><xsl:otherwise>zh-CN</xsl:otherwise></xsl:choose></xsl:attribute>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title><xsl:value-of select="/rss/channel/title" /> · RSS</title>
        <link rel="stylesheet" href="/rss.css" />
      </head>
      <body>
        <main class="feed">
          <p class="feed__brand"><span class="feed__mark">AZ</span>AZ Studio</p>
          <div class="feed__note">
            <xsl:choose>
              <xsl:when test="$en">
                <strong>This is an RSS feed.</strong> Copy the address bar URL into your feed reader (Feedly, Inoreader, NetNewsWire…) to follow updates. No account needed.
              </xsl:when>
              <xsl:otherwise>
                <strong>这是 RSS 订阅源。</strong>把地址栏里的网址复制到 RSS 阅读器（Feedly、Inoreader、NetNewsWire 等）即可订阅，不需要注册。
              </xsl:otherwise>
            </xsl:choose>
          </div>
          <h1><xsl:value-of select="/rss/channel/title" /></h1>
          <p class="feed__desc"><xsl:value-of select="/rss/channel/description" /></p>
          <p class="feed__links">
            <a class="feed__btn" href="{/rss/channel/link}">
              <xsl:choose><xsl:when test="$en">Visit site</xsl:when><xsl:otherwise>访问网站</xsl:otherwise></xsl:choose>
            </a>
            <a href="/subscribe/">
              <xsl:choose><xsl:when test="$en">Email updates</xsl:when><xsl:otherwise>改用邮件订阅</xsl:otherwise></xsl:choose>
            </a>
          </p>
          <ol class="feed__list">
            <xsl:for-each select="/rss/channel/item">
              <li>
                <a href="{link}"><xsl:value-of select="title" /></a>
                <p><xsl:value-of select="substring(description, 1, 140)" /></p>
                <time><xsl:value-of select="substring(pubDate, 6, 11)" /></time>
              </li>
            </xsl:for-each>
          </ol>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
