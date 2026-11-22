namespace SmtcTool;

/// <summary>一个媒体会话的信息（一行 JSON）</summary>
public class SessionInfo
{
    public string? SourceAppId { get; set; }
    public string? PlaybackState { get; set; }
    public string? Title { get; set; }
    public string? Artist { get; set; }
    public string? Album { get; set; }
    public string? Error { get; set; }
}
