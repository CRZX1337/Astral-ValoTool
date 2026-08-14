using Astral;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Astral.Tests;

public sealed class SecurityTests
{
    [Fact]
    public void Pairing_token_is_accepted_from_query_header_and_cookie()
    {
        const string token = "0123456789abcdef0123456789abcdef";

        var query = new DefaultHttpContext();
        query.Request.QueryString = new QueryString("?k=" + token);
        Assert.True(Program.IsPaired(query.Request, token));

        var header = new DefaultHttpContext();
        header.Request.Headers["X-Astral-Token"] = token;
        Assert.True(Program.IsPaired(header.Request, token));

        var cookie = new DefaultHttpContext();
        cookie.Request.Headers.Cookie = "astral_pair=" + token;
        Assert.True(Program.IsPaired(cookie.Request, token));
    }

    [Fact]
    public void Wrong_or_missing_pairing_token_is_rejected()
    {
        const string token = "0123456789abcdef0123456789abcdef";
        var context = new DefaultHttpContext();

        Assert.False(Program.IsPaired(context.Request, token));

        context.Request.QueryString = new QueryString("?k=wrong");
        Assert.False(Program.IsPaired(context.Request, token));
    }

    [Fact]
    public void Foreign_origin_is_rejected_but_same_origin_and_missing_origin_are_allowed()
    {
        Assert.False(Program.IsForeignOrigin(null, "http", "127.0.0.1:1234"));
        Assert.False(Program.IsForeignOrigin("HTTP://127.0.0.1:1234", "http", "127.0.0.1:1234"));
        Assert.True(Program.IsForeignOrigin("https://evil.example", "http", "127.0.0.1:1234"));
        Assert.True(Program.IsForeignOrigin("http://127.0.0.1:9999", "http", "127.0.0.1:1234"));
    }
}
