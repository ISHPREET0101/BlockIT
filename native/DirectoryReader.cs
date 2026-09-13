// Metadata only: never opens file contents or follows directory reparse points.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class DirectoryReader
{
    // Protocol: one JSON object per line on stdio.
    //   {"op":"open","path":...,"x":["excluded",...]}  starts a subtree walk:
    //   the helper enumerates the directory and then its child directories
    //   back to back (bounded), so the pipe stays full without one round trip
    //   per directory. {"op":"next"} streams more of the same subtree.
    //   {"op":"close"} exits.
    //   {"op":"volume","path":"C:\\","x":[...]} scans a whole NTFS volume by
    //   reading the Master File Table directly (administrator required), then
    //   streams the same batch shape; "next" continues the walk.
    //   {"op":"admin","path":"C:\\"} answers {"admin":b,"ntfs":b} without
    //   changing state, so callers can predict whether "volume" can run.
    //   {"op":"pause"/"resume"} are accepted and ignored: batching is already
    //   demand-driven, so an unread pipe is the pause.
    // Each response carries at most BatchSize entries plus the frontier:
    //   dirs      newly discovered directories {i,p,n,m} (index, parent index,
    //             name, listing mtime); index 0 is the request root
    //   doneDirs  indices whose enumeration fully completed in this response
    //   pending   directories discovered beyond the walk cap {i,p,n,m}: the
    //             caller schedules them itself
    //   errors    directories that could not be opened {i,e}
    // Entries reference their parent directory through "p". Excluded prefixes
    // ("x", case-insensitive) are never entered. Reparse directories are
    // reported as links and never entered. Directories appear only in dirs —
    // the caller creates their rows there; entries carry files and links.
    // A volume response also sets "denied" (needs elevation) or "unsupported"
    // (not NTFS) instead of touching the walk state, so the caller can fall
    // back to directory scanning on the same reader.
    const int BatchSize = 4096;
    const int PrefetchDirs = 2048;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 4)]
    private struct FindData
    {
        public uint Attributes;
        public long Created, Accessed, Modified;
        public uint SizeHigh, SizeLow, ReparseTag, Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInfo
    {
        public uint Attributes;
        public long Created, Accessed, Modified;
        public uint VolumeSerial, SizeHigh, SizeLow, LinksHigh, LinksLow;
        public uint FileIdHigh, FileIdLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileExW(string path, int info, out FindData data, int search, IntPtr filter, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr handle, out FindData data);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder buffer, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileTime(IntPtr handle, out long created, out long accessed, out long written);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out HandleInfo info);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(IntPtr handle, byte[] buffer, int toRead, out int read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFilePointerEx(IntPtr handle, long distance, out long newPointer, int origin);

    private static readonly IntPtr Invalid = new IntPtr(-1);
    private static IntPtr handle = Invalid;
    private static FindData current;
    private static long requestStarted;
    private static readonly StringBuilder Out = new StringBuilder(BatchSize * 128 + 4096);
    private static void Close() { if (handle != Invalid) FindClose(handle); handle = Invalid; }
    private static string Extended(string path)
    {
        if (path.StartsWith(@"\\?\")) return path;
        return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }

    // Resolves the opened directory itself without following its final reparse
    // point: the fresh write time, the real final path (catches an ancestor that
    // became a junction after it was queued) and reparse/directory flags (catch a
    // folder swapped for a junction or a file). One handle, no extra round trip.
    private static string Probe(string directory)
    {
        IntPtr probe = CreateFileW(Extended(directory), 0x80, 7, IntPtr.Zero, 3,
            0x02000000 | 0x00200000, IntPtr.Zero);
        if (probe == Invalid) return null;
        try
        {
            HandleInfo info;
            long created, accessed, written;
            if (!GetFileInformationByHandle(probe, out info) || !GetFileTime(probe, out created, out accessed, out written)) return null;
            var buffer = new StringBuilder(600);
            uint length = GetFinalPathNameByHandleW(probe, buffer, 600, 0);
            if (length == 0) return null;
            if (length > 600) { buffer = new StringBuilder((int)length); length = GetFinalPathNameByHandleW(probe, buffer, length, 0); if (length == 0 || length > (uint)buffer.Capacity) return null; }
            string final = buffer.ToString(0, (int)length);
            if (final.StartsWith(@"\\?\UNC\")) final = @"\\" + final.Substring(8);
            else if (final.StartsWith(@"\\?\")) final = final.Substring(4);
            uint a = info.Attributes;
            Out.Length = 0;
            Out.Append("{\"modifiedAt\":").Append(written / 10000L - 11644473600000L)
                .Append(",\"path\":"); Quote(final);
            Out.Append(",\"directory\":").Append((a & 16) != 0 ? "true" : "false")
                .Append(",\"reparse\":").Append((a & 1024) != 0 ? "true" : "false").Append('}');
            return Out.ToString();
        }
        finally { CloseHandle(probe); }
    }

    private static void Quote(string value) { QuoteTo(Out, value); }

    private static void QuoteTo(StringBuilder target, string value)
    {
        target.Append('"');
        foreach (char c in value)
        {
            if (c == '"' || c == '\\') { target.Append('\\'); target.Append(c); }
            else if (c == '\n') target.Append("\\n");
            else if (c == '\r') target.Append("\\r");
            else if (c == '\t') target.Append("\\t");
            else if (c == '\b') target.Append("\\b");
            else if (c < ' ') target.Append("\\u").Append(((int)c).ToString("x4"));
            else target.Append(c);
        }
        target.Append('"');
    }

    private class WalkDir
    {
        public int Parent;
        public string Name;
        public long Modified;
    }

    // Subtree walk state for the current open request. Index 0 is the request
    // root; children are walked breadth-first inside the helper up to
    // PrefetchDirs, so a huge subtree cannot queue unbounded work here —
    // anything beyond the cap is reported as pending for the caller.
    private static readonly List<WalkDir> walk = new List<WalkDir>();
    private static readonly Queue<int> frontier = new Queue<int>();
    private static readonly List<string> excluded = new List<string>();
    private static int activeIndex = -1;
    private static bool walkComplete;

    private static bool Excluded(string parentPath, string name)
    {
        if (excluded.Count == 0) return false;
        string full = (parentPath.EndsWith("\\") ? parentPath + name : parentPath + "\\" + name);
        for (int i = 0; i < excluded.Count; i++)
        {
            string p = excluded[i];
            if (string.Equals(full, p, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static void AppendEntry(int parent, string name, uint attributes, long modified, long size, bool folder, bool reparse)
    {
        bool link = reparse && (folder || current.ReparseTag == 0xA000000C || current.ReparseTag == 0xA0000003);
        Out.Append("{\"p\":").Append(parent).Append(",\"n\":"); Quote(name);
        Out.Append(",\"k\":\"").Append(link ? "link" : folder ? "folder" : "file").Append('"');
        Out.Append(",\"s\":").Append(folder || link ? 0L : size);
        Out.Append(",\"m\":").Append(modified);
        Out.Append(",\"a\":\"");
        if ((attributes & 1) != 0) Out.Append("Read-only, ");
        if ((attributes & 2) != 0) Out.Append("Hidden, ");
        if ((attributes & 4) != 0) Out.Append("System, ");
        if ((attributes & 512) != 0) Out.Append("Sparse, ");
        if ((attributes & 2048) != 0) Out.Append("Compressed, ");
        if (reparse) Out.Append("Reparse point");
        Out.Append("\"}");
    }

    private static int error;
    private static string self;

    private static void WriteBatch(string directory, List<string> excludeList)
    {
        var dirsOut = new List<int>();
        var doneOut = new List<int>();
        var pendingOut = new List<int>();
        var errorsOut = new List<string>();
        if (directory != null)
        {
            Close();
            self = null;
            walk.Clear(); frontier.Clear(); excluded.Clear();
            activeIndex = -1; walkComplete = false;
            foreach (string ex in excludeList) excluded.Add(ex);
            // Root exclusion: nothing to walk.
            bool rootExcluded = false;
            foreach (string ex in excluded)
                if (string.Equals(directory.TrimEnd('\\'), ex.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) { rootExcluded = true; break; }
            walk.Add(new WalkDir { Parent = -1, Name = directory, Modified = 0 });
            string pattern = Extended(directory).TrimEnd('\\') + @"\*";
            handle = FindFirstFileExW(pattern, 1, out current, 0, IntPtr.Zero, 2);
            error = handle == Invalid ? Marshal.GetLastWin32Error() : 0;
            if (error == 87 || error == 50)
            {
                handle = FindFirstFileExW(pattern, 1, out current, 0, IntPtr.Zero, 0);
                error = handle == Invalid ? Marshal.GetLastWin32Error() : 0;
            }
            if (handle != Invalid) self = Probe(directory);
            if (rootExcluded) { Close(); walkComplete = true; }
            else if (handle != Invalid) frontier.Enqueue(0);
            else walkComplete = true;
        }
        Out.Length = 0;
        Out.Append("{\"entries\":[");
        bool first = true;
        int count = 0;
        while (count < BatchSize && !walkComplete)
        {
            if (activeIndex == -1)
            {
                if (frontier.Count == 0) { walkComplete = true; break; }
                int index = frontier.Dequeue();
                string dirPath = index == 0 ? walk[0].Name : ParentPath(index);
                string pattern = Extended(dirPath).TrimEnd('\\') + @"\*";
                handle = FindFirstFileExW(pattern, 1, out current, 0, IntPtr.Zero, 2);
                int openError = handle == Invalid ? Marshal.GetLastWin32Error() : 0;
                if (openError == 87 || openError == 50)
                    handle = FindFirstFileExW(pattern, 1, out current, 0, IntPtr.Zero, 0);
                if (handle == Invalid)
                {
                    if (openError != 0 && openError != 2 && openError != 18) errorsOut.Add(RenderError(index, openError));
                    doneOut.Add(index);
                    continue;
                }
                activeIndex = index;
            }
            if (current.Name != "." && current.Name != "..")
            {
                uint a = current.Attributes;
                bool folder = (a & 16) != 0, reparse = (a & 1024) != 0;
                bool link = reparse && (folder || current.ReparseTag == 0xA000000C || current.ReparseTag == 0xA0000003);
                if (!folder || link)
                {
                    // Files and links stream as entries; plain directories are
                    // announced through dirs below, where the caller creates
                    // their rows exactly once.
                    if (!first) Out.Append(',');
                    first = false;
                    count++;
                    AppendEntry(activeIndex, current.Name, a, current.Modified / 10000L - 11644473600000L,
                        ((long)current.SizeHigh << 32) | current.SizeLow, folder, reparse);
                }
                if (folder && !link)
                {
                    // Directory children join this walk (bounded); the caller
                    // learns about them through dirs/pending.
                    string name = current.Name;
                    long modified = current.Modified / 10000L - 11644473600000L;
                    if (!Excluded(ParentPath(activeIndex), name))
                    {
                        var info = new WalkDir { Parent = activeIndex, Name = name, Modified = modified };
                        int index = walk.Count;
                        walk.Add(info);
                        // dirs entries are walked here and completed through
                        // doneDirs; beyond-cap dirs are the caller's job and
                        // must appear only in pending — announcing them in
                        // both would duplicate their rows caller-side.
                        if (walk.Count <= PrefetchDirs) { frontier.Enqueue(index); dirsOut.Add(index); }
                        else pendingOut.Add(index);
                    }
                }
            }
            if (!FindNextFileW(handle, out current))
            {
                int endError = Marshal.GetLastWin32Error();
                Close();
                if (endError != 0 && endError != 18 && endError != 2) errorsOut.Add(RenderError(activeIndex, endError));
                doneOut.Add(activeIndex);
                activeIndex = -1;
            }
        }
        if (count >= BatchSize && !walkComplete)
        {
            // Exhausted the batch mid-walk: the rest streams on "next".
        }
        else if (walkComplete && activeIndex != -1)
        {
            // Batch limit reached with an open handle; keep streaming later.
        }
        Out.Append("],\"dirs\":[");
        bool firstItem = true;
        foreach (int index in dirsOut)
        {
            if (!firstItem) Out.Append(',');
            firstItem = false;
            Out.Append("{\"i\":").Append(index).Append(",\"p\":").Append(walk[index].Parent)
                .Append(",\"n\":"); Quote(walk[index].Name);
            Out.Append(",\"m\":").Append(walk[index].Modified).Append('}');
        }
        Out.Append("],\"doneDirs\":[");
        firstItem = true;
        foreach (int index in doneOut)
        {
            if (!firstItem) Out.Append(',');
            firstItem = false;
            Out.Append(index);
        }
        Out.Append("],\"pending\":[");
        firstItem = true;
        foreach (int index in pendingOut)
        {
            if (!firstItem) Out.Append(',');
            firstItem = false;
            Out.Append("{\"i\":").Append(index).Append(",\"p\":").Append(walk[index].Parent)
                .Append(",\"n\":"); Quote(walk[index].Name);
            Out.Append(",\"m\":").Append(walk[index].Modified).Append('}');
        }
        Out.Append("],\"errors\":[");
        firstItem = true;
        foreach (string rendered in errorsOut)
        {
            if (!firstItem) Out.Append(',');
            firstItem = false;
            Out.Append(rendered);
        }
        Out.Append("],\"done\":").Append(walkComplete ? "true" : "false");
        Out.Append(",\"error\":");
        if (error == 0 || error == 2 || error == 18 || error == 5) Out.Append("null");
        else Quote(new Win32Exception(error).Message);
        Out.Append(",\"self\":").Append(directory != null && self != null ? self : "null");
        Out.Append('}');
#if WALKTRACE
        if (directory != null || dirsOut.Count > 0 || pendingOut.Count > 0 || doneOut.Count > 0)
            Console.Error.WriteLine("WALK walkCount=" + walk.Count + " frontier=" + frontier.Count + " active=" + activeIndex
                + " dirs=" + dirsOut.Count + " pending=" + pendingOut.Count + " doneDirs=" + doneOut.Count + " done=" + walkComplete);
#endif
        Console.WriteLine(Out.ToString());
    }

    // ===================== Volume (MFT) fast scan =====================
    // Reads the NTFS Master File Table directly: one sequential pass builds the
    // whole volume tree in memory, then batches stream over the same protocol
    // as directory walks. Opening \\.\C: with GENERIC_READ needs administrator
    // rights; on denial the response reports it and the caller falls back to
    // directory scanning without killing this helper.

    private static bool volumeRequest;
    private static bool VolumeDenied;
    private static bool VolumeUnsupported;

    // Env-gated diagnostics: BLOCKIT_VOLUME_DEBUG=1 streams parse-stage counters
    // to stderr so a truncated volume tree can be traced to its drop reason.
    private static readonly bool VolDebug = Environment.GetEnvironmentVariable("BLOCKIT_VOLUME_DEBUG") == "1";
    private static long dbgMagic, dbgFixup, dbgNotInUse, dbgNoName, dbgMeta, dbgBadParent, dbgSelf, dbgParsed, dbgExtZeroed, dbgOrphanParent, dbgOrphanNotDir, dbgLinked;

    // One directory awaiting enumeration in the volume walk. Announced child
    // directories queue here and join the frontier when their parent finishes,
    // mirroring the depth-first order of directory walks so the caller's
    // per-folder bookkeeping stays small.
    private sealed class VolSlot
    {
        public int Record;
        public int WalkIndex;
        public int Cursor;
        public string Path;
        public List<int[]> Announced;
    }

    // Record numbers are dense integers, so parallel arrays beat a dictionary;
    // kind 0 marks records without a tree node. Index 5 is the volume root.
    private static int[] volParent;
    private static long[] volSize;
    private static long[] volModified;
    private static byte[] volKind;    // 0 none, 1 file, 2 dir, 3 link
    private static byte[] volFlags;   // packed attribute bits for the report
    private static string[] volName;
    private static Dictionary<int, List<int>> volChildren;
    private static int volRecordCount;
    private static List<VolSlot> volStack;
    private static int volTop;
    private static int volNextWalk;
    private static List<string> volExcluded;
    private static string volRootPath;

    private static long FileTimeToMs(long value)
    {
        if (value <= 0) return 0;
        return value / 10000L - 11644473600000L;
    }

    private static IntPtr OpenVolumeHandle(string rootPath)
    {
        if (rootPath == null || rootPath.Length < 2 || rootPath[1] != ':') return Invalid;
        // Test seam: exercise the identical parse path against a crafted image
        // file when the environment supplies one.
        string image = Environment.GetEnvironmentVariable("BLOCKIT_VOLUME_IMAGE");
        if (!string.IsNullOrEmpty(image))
            return CreateFileW(image, 0x80000000u, 1 | 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
        return CreateFileW(@"\\.\" + rootPath.Substring(0, 2), 0x80000000u, 1 | 2, IntPtr.Zero, 3, 0, IntPtr.Zero);
    }

    private static bool ReadAt(IntPtr handle, byte[] buffer, long position, int count)
    {
        long moved;
        if (!SetFilePointerEx(handle, position, out moved, 0)) return false;
        int total = 0;
        while (total < count)
        {
            int got;
            if (!ReadFile(handle, buffer, count - total, out got, IntPtr.Zero)) return false;
            if (got == 0) return false;
            total += got;
        }
        return true;
    }

    // Multi-sector records protect their sector tails with an update sequence
    // array; every sector's last word must hold the sequence number and is
    // restored to its stored original before parsing.
    private static bool ApplyFixup(byte[] buffer, int offset, int length)
    {
        int usaOffset = BitConverter.ToUInt16(buffer, offset + 4);
        int usaCount = BitConverter.ToUInt16(buffer, offset + 6);
        if (usaCount < 1 || usaOffset < 0x10 || usaOffset + usaCount * 2 > length) return false;
        int sequence = BitConverter.ToUInt16(buffer, offset + usaOffset);
        for (int i = 1; i < usaCount; i++)
        {
            int sectorEnd = offset + i * 512 - 2;
            if (sectorEnd + 2 > offset + length) return false;
            if (BitConverter.ToUInt16(buffer, sectorEnd) != sequence) return false;
            buffer[sectorEnd] = buffer[offset + usaOffset + i * 2];
            buffer[sectorEnd + 1] = buffer[offset + usaOffset + i * 2 + 1];
        }
        return true;
    }

    private static void ParseRuns(byte[] record, int pos, int limit, long clusterBytes, List<long[]> runs)
    {
        // runs: {offset within $MFT in bytes, length in bytes, volume byte
        // offset} with -1 marking a sparse zone.
        long lcn = 0, offsetInMft = 0;
        while (pos < limit && record[pos] != 0)
        {
            int header = record[pos++];
            // NTFS datarun header: low nibble sizes the length field, high
            // nibble the offset field. Swapping them decodes sane-looking
            // extents for symmetric headers (0x11) and garbage for asymmetric
            // ones (0x43) — a 69 GB "$MFT extent" on a real drive.
            int lengthLen = header & 0xf, offsetLen = (header >> 4) & 0xf;
            if (lengthLen == 0 || lengthLen > 8 || offsetLen > 8 || pos + lengthLen + offsetLen > limit) break;
            long length = 0;
            for (int i = 0; i < lengthLen; i++) length |= (long)record[pos + i] << (8 * i);
            pos += lengthLen;
            long offset = 0;
            bool negative = offsetLen > 0 && (record[pos + offsetLen - 1] & 0x80) != 0;
            for (int i = 0; i < offsetLen; i++) offset |= (long)record[pos + i] << (8 * i);
            pos += offsetLen;
            if (negative) offset -= 1L << (8 * offsetLen);
            long lengthBytes = length * clusterBytes;
            if (offsetLen == 0) runs.Add(new[] { offsetInMft, lengthBytes, -1L });
            else { lcn += offset; runs.Add(new[] { offsetInMft, lengthBytes, lcn * clusterBytes }); }
            offsetInMft += lengthBytes;
        }
    }

    private static void ParseVolumeRecord(byte[] buffer, int offset, int recordSize, int recNum, HashSet<int> extensionRecords)
    {
        if (recNum < 0 || recNum >= volRecordCount) return;
        if (buffer[offset] != 'F' || buffer[offset + 1] != 'I' || buffer[offset + 2] != 'L' || buffer[offset + 3] != 'E') { dbgMagic++; return; }
        if (!ApplyFixup(buffer, offset, recordSize)) { dbgFixup++; return; }
        ushort flags = BitConverter.ToUInt16(buffer, offset + 0x16);
        if ((flags & 1) == 0) { dbgNotInUse++; return; }                 // record not in use: deleted
        bool isDir = (flags & 2) != 0;
        int end = offset + recordSize;
        int pos = offset + BitConverter.ToUInt16(buffer, offset + 0x14);
        long parent = -1, size = 0, modified = 0;
        uint siFlags = 0;
        bool haveSi = false;
        int bestNamespace = -1;
        string name = null;
        while (pos + 16 <= end)
        {
            uint type = BitConverter.ToUInt32(buffer, pos);
            if (type == 0xffffffffu) break;
            int len = BitConverter.ToInt32(buffer, pos + 4);
            if (len < 16 || pos + len > end) break;
            bool resident = buffer[pos + 8] == 0;
            int nameChars = buffer[pos + 9];
            if (type == 0x10 && resident)
            {
                // $STANDARD_INFORMATION: authoritative timestamps and flags.
                int contentOff = pos + BitConverter.ToUInt16(buffer, pos + 0x14);
                int contentLen = BitConverter.ToInt32(buffer, pos + 0x10);
                if (contentLen >= 0x24 && contentOff >= pos && contentOff + contentLen <= end)
                {
                    modified = FileTimeToMs(BitConverter.ToInt64(buffer, contentOff + 8));
                    siFlags = BitConverter.ToUInt32(buffer, contentOff + 0x20);
                    haveSi = true;
                }
            }
            else if (type == 0x30 && resident)
            {
                // $FILE_NAME: parent reference and the name itself. DOS-only
                // aliases duplicate a Win32 name; hard links appear as extra
                // name attributes, of which the first usable one is kept.
                int contentOff = pos + BitConverter.ToUInt16(buffer, pos + 0x14);
                int contentLen = BitConverter.ToInt32(buffer, pos + 0x10);
                if (contentLen >= 0x42 && contentOff >= pos && contentOff + contentLen <= end)
                {
                    int space = buffer[contentOff + 0x41];
                    if (space != 2 && space > bestNamespace && space <= 4)
                    {
                        int nameLen = buffer[contentOff + 0x40];
                        if (nameLen > 0 && 0x42 + nameLen * 2 <= contentLen)
                        {
                            parent = BitConverter.ToInt64(buffer, contentOff) & 0x0000ffffffffffffL;
                            name = Encoding.Unicode.GetString(buffer, contentOff + 0x42, nameLen * 2);
                            bestNamespace = space;
                            if (!haveSi) modified = FileTimeToMs(BitConverter.ToInt64(buffer, contentOff + 0x10));
                        }
                    }
                }
            }
            else if (type == 0x80 && nameChars == 0)
            {
                // Unnamed $DATA: the file's logical size.
                if (resident) size = BitConverter.ToUInt32(buffer, pos + 0x10);
                else { size = BitConverter.ToInt64(buffer, pos + 0x30); if (size < 0) size = 0; }
            }
            else if (type == 0x20 && resident)
            {
                // $ATTRIBUTE_LIST: attributes continued in extension records;
                // those records belong to their base record, never to the tree.
                int contentOff = pos + BitConverter.ToUInt16(buffer, pos + 0x14);
                int contentLen = BitConverter.ToInt32(buffer, pos + 0x10);
                int scan = contentOff, scanEnd = contentOff + contentLen;
                if (contentOff >= pos && scanEnd <= end)
                {
                    while (scan + 8 <= scanEnd)
                    {
                        int entryLen = BitConverter.ToUInt16(buffer, scan + 4);
                        if (entryLen < 8 || scan + entryLen > scanEnd) break;
                        long reference = BitConverter.ToInt64(buffer, scan + 16) & 0x0000ffffffffffffL;
                        if (reference != recNum && reference >= 0 && reference < volRecordCount) extensionRecords.Add((int)reference);
                        scan += entryLen;
                    }
                }
            }
            pos += len;
        }
        if (recNum == 5)
        {
            volKind[5] = 2; volParent[5] = -1; volName[5] = ".";
            volModified[5] = modified;
            dbgSelf++;
            return;
        }
        if (name == null) { dbgNoName++; return; }
        if (recNum < 24) { dbgMeta++; return; }       // metafiles and reserved records
        if (parent < 0 || parent >= volRecordCount || parent == recNum) { dbgBadParent++; return; }
        volParent[recNum] = (int)parent;
        volModified[recNum] = modified;
        bool reparse = (siFlags & 0x400) != 0;
        volKind[recNum] = isDir ? (byte)(reparse ? 3 : 2) : (byte)(reparse ? 3 : 1);
        if (volKind[recNum] == 1) volSize[recNum] = size;
        volFlags[recNum] = (byte)((siFlags & 0x7) | ((siFlags & 0x200) >> 6) | ((siFlags & 0x800) >> 7) | ((siFlags & 0x400) >> 5));
        volName[recNum] = name;
        dbgParsed++;
    }

    private static void BuildVolumeChildren()
    {
        volChildren = new Dictionary<int, List<int>>();
        for (int rec = 0; rec < volRecordCount; rec++)
        {
            byte kind = volKind[rec];
            if (kind == 0 || rec == 5) continue;
            int parent = volParent[rec];
            // Orphans (parent deleted or outside the tree) and children of
            // reparse directories stay invisible, matching directory walks.
            if (parent < 0 || parent >= volRecordCount) { dbgOrphanParent++; volKind[rec] = 0; volName[rec] = null; continue; }
            if (volKind[parent] != 2) { dbgOrphanNotDir++; volKind[rec] = 0; volName[rec] = null; continue; }
            dbgLinked++;
            List<int> kids;
            if (!volChildren.TryGetValue(parent, out kids)) { kids = new List<int>(); volChildren.Add(parent, kids); }
            kids.Add(rec);
        }
        if (VolDebug)
        {
            List<int> rootKids;
            volChildren.TryGetValue(5, out rootKids);
            Console.Error.WriteLine("VOLDBG tree linked=" + dbgLinked + " orphanParent=" + dbgOrphanParent + " orphanNotDir=" + dbgOrphanNotDir
                + " rootKids=" + (rootKids != null ? rootKids.Count : 0));
        }
    }

    private static int ResolveVolumeRoot(string rootPath)
    {
        string trimmed = rootPath.TrimEnd('\\');
        if (trimmed.Length < 2 || trimmed[1] != ':') return -1;
        string[] parts = trimmed.Split('\\');
        int current = 5;   // parts[0] is the drive itself
        for (int i = 1; i < parts.Length; i++)
        {
            if (parts[i].Length == 0) continue;
            List<int> kids;
            if (!volChildren.TryGetValue(current, out kids)) return -1;
            int found = -1;
            foreach (int kid in kids)
            {
                if (volKind[kid] == 2 && string.Equals(volName[kid], parts[i], StringComparison.OrdinalIgnoreCase)) { found = kid; break; }
            }
            if (found < 0) return -1;
            current = found;
        }
        return current;
    }

    private static string VolDirPath(int record)
    {
        var parts = new List<string>();
        int cursor = record;
        while (cursor > 5 && cursor < volRecordCount && volKind[cursor] != 0)
        {
            parts.Add(volName[cursor]);
            cursor = volParent[cursor];
        }
        var builder = new StringBuilder(volRootPath != null ? volRootPath.Length + 64 : 128);
        builder.Append(volRootPath == null ? "" : volRootPath.TrimEnd('\\'));
        for (int i = parts.Count - 1; i >= 0; i--) builder.Append('\\').Append(parts[i]);
        return builder.ToString();
    }

    private static bool IsExcludedDir(string parentPath, string name)
    {
        if (volExcluded.Count == 0 || parentPath == null) return false;
        string full = parentPath.EndsWith("\\") ? parentPath + name : parentPath + "\\" + name;
        for (int i = 0; i < volExcluded.Count; i++)
            if (string.Equals(full, volExcluded[i], StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void AppendAttributes(uint flags)
    {
        // Packed bits: 1 read-only, 2 hidden, 4 system, 8 sparse, 16
        // compressed, 32 reparse.
        if ((flags & 1) != 0) Out.Append("Read-only, ");
        if ((flags & 2) != 0) Out.Append("Hidden, ");
        if ((flags & 4) != 0) Out.Append("System, ");
        if ((flags & 8) != 0) Out.Append("Sparse, ");
        if ((flags & 16) != 0) Out.Append("Compressed, ");
        if ((flags & 32) != 0) Out.Append("Reparse point");
    }

    private static void ReleaseVolume()
    {
        volParent = null; volSize = null; volModified = null; volKind = null;
        volFlags = null; volName = null; volChildren = null;
        volStack = null; volTop = 0;
    }

    private static void WriteVolumeBatch(string directory, List<string> excludeList)
    {
        var doneOut = new List<int>();
        string selfJson = null;
        string responseError = null;
        bool denied = false, unsupported = false, walkDone = false;
        if (directory != null)
        {
            ReleaseVolume();
            volExcluded = excludeList;
            volRootPath = directory;
            volNextWalk = 1;
            string loadError;
            if (!LoadVolume(directory, out loadError))
            {
                denied = VolumeDenied; unsupported = VolumeUnsupported;
                responseError = loadError;
            }
            else
            {
                int root = ResolveVolumeRoot(directory);
                if (root < 0) responseError = "The scan location is not present on this volume.";
                else
                {
                    volStack = new List<VolSlot>();
                    volTop = 0;
                    PushSlot(new VolSlot { Record = root, WalkIndex = 0, Cursor = 0, Path = directory });
                    var self = new StringBuilder(128);
                    self.Append("{\"modifiedAt\":").Append(volModified[root] >= 0 ? volModified[root] : 0)
                        .Append(",\"path\":"); QuoteTo(self, directory);
                    self.Append(",\"directory\":true,\"reparse\":false}");
                    selfJson = self.ToString();
                }
            }
        }
        Out.Length = 0;
        Out.Append("{\"entries\":[");
        bool first = true;
        int count = 0;
        var dirs = new StringBuilder(4096);
        while (responseError == null && count < BatchSize && volTop > 0)
        {
            VolSlot slot = volStack[volTop - 1];
            List<int> kids;
            List<int> list = volChildren.TryGetValue(slot.Record, out kids) ? kids : null;
            string parentPath = slot.Path;
            if (parentPath == null && volExcluded.Count > 0) { parentPath = VolDirPath(slot.Record); slot.Path = parentPath; }
            int i = slot.Cursor;
            if (list != null)
            {
                for (; i < list.Count && count < BatchSize; i++)
                {
                    int kid = list[i];
                    byte kind = volKind[kid];
                    string name = volName[kid];
                    if (kind == 2)
                    {
                        if (IsExcludedDir(parentPath, name)) continue;
                        int walkIndex = volNextWalk++;
                        if (slot.Announced == null) slot.Announced = new List<int[]>();
                        slot.Announced.Add(new[] { kid, walkIndex });
                        if (dirs.Length > 0) dirs.Append(',');
                        dirs.Append("{\"i\":").Append(walkIndex).Append(",\"p\":").Append(slot.WalkIndex)
                            .Append(",\"n\":"); QuoteTo(dirs, name);
                        dirs.Append(",\"m\":").Append(volModified[kid]).Append('}');
                    }
                    else
                    {
                        if (!first) Out.Append(',');
                        first = false;
                        count++;
                        Out.Append("{\"p\":").Append(slot.WalkIndex).Append(",\"n\":"); Quote(name);
                        Out.Append(",\"k\":\"").Append(kind == 3 ? "link" : "file").Append('"');
                        Out.Append(",\"s\":").Append(kind == 1 ? volSize[kid] : 0L);
                        Out.Append(",\"m\":").Append(volModified[kid]).Append(",\"a\":\"");
                        AppendAttributes(volFlags[kid]);
                        Out.Append("\"}");
                    }
                }
            }
            slot.Cursor = i;
            if (i >= (list != null ? list.Count : 0))
            {
                volTop--;
                if (slot.Announced != null)
                {
                    // Depth-first: the finished folder's announced children are
                    // enumerated before any earlier sibling resumes.
                    for (int j = 0; j < slot.Announced.Count; j++)
                    {
                        int[] announced = slot.Announced[j];
                        string childPath = parentPath == null ? null :
                            (parentPath.EndsWith("\\") ? parentPath : parentPath + "\\") + volName[announced[0]];
                        PushSlot(new VolSlot { Record = announced[0], WalkIndex = announced[1], Cursor = 0, Path = childPath });
                    }
                    slot.Announced = null;
                }
                doneOut.Add(slot.WalkIndex);
                if (volTop == 0) walkDone = true;
            }
        }
        if (responseError == null && volTop == 0) walkDone = true;
        if (walkDone) ReleaseVolume();
        Out.Append("],\"dirs\":[");
        Out.Append(dirs.ToString());
        Out.Append("],\"doneDirs\":[");
        for (int i = 0; i < doneOut.Count; i++) { if (i > 0) Out.Append(','); Out.Append(doneOut[i]); }
        Out.Append("],\"pending\":[],\"errors\":[],\"done\":").Append(walkDone ? "true" : "false");
        Out.Append(",\"error\":");
        if (responseError == null) Out.Append("null");
        else Quote(responseError);
        Out.Append(",\"denied\":").Append(denied ? "true" : "false");
        Out.Append(",\"unsupported\":").Append(unsupported ? "true" : "false");
        Out.Append(",\"self\":").Append(selfJson ?? "null");
        Out.Append('}');
        Console.WriteLine(Out.ToString());
    }

    private static void PushSlot(VolSlot slot)
    {
        if (volTop < volStack.Count) volStack[volTop] = slot;
        else volStack.Add(slot);
        volTop++;
    }

    private static bool LoadVolume(string rootPath, out string error)
    {
        error = null;
        VolumeDenied = false;
        VolumeUnsupported = false;
        dbgMagic = dbgFixup = dbgNotInUse = dbgNoName = dbgMeta = dbgBadParent = dbgSelf = dbgParsed = 0;
        dbgExtZeroed = dbgOrphanParent = dbgOrphanNotDir = dbgLinked = 0;
        IntPtr handle = OpenVolumeHandle(rootPath);
        if (handle == Invalid)
        {
            int err = Marshal.GetLastWin32Error();
            VolumeDenied = err == 5;
            error = VolumeDenied
                ? "Administrator rights are required to read this drive directly."
                : "The drive could not be opened for direct access (" + new Win32Exception(err).Message + ").";
            return false;
        }
        try
        {
            var boot = new byte[512];
            if (!ReadAt(handle, boot, 0, 512)) { error = "The drive's boot sector could not be read."; return false; }
            if (boot[3] != 'N' || boot[4] != 'T' || boot[5] != 'F' || boot[6] != 'S')
            {
                VolumeUnsupported = true;
                error = "Fast drive scans need an NTFS drive.";
                return false;
            }
            int bytesPerSector = BitConverter.ToUInt16(boot, 0x0b);
            int sectorsPerCluster = boot[0x0d] == 0 ? 1 : boot[0x0d];
            long clusterBytes = (long)bytesPerSector * sectorsPerCluster;
            long mftLcn = BitConverter.ToInt64(boot, 0x30);
            sbyte clustersPerRecord = unchecked((sbyte)boot[0x40]);
            long recordSize = clustersPerRecord < 0 ? 1L << -clustersPerRecord : clustersPerRecord * clusterBytes;
            if (recordSize < 1024 || recordSize > 4096 || (recordSize & (recordSize - 1)) != 0)
            {
                error = "Unsupported MFT record size.";
                return false;
            }
            // Record 0 is $MFT itself; its unnamed $DATA attribute carries the
            // run list that maps the whole table.
            var record0 = new byte[recordSize];
            if (!ReadAt(handle, record0, mftLcn * clusterBytes, (int)recordSize)) { error = "$MFT could not be located."; return false; }
            if (record0[0] != 'F' || record0[1] != 'I' || record0[2] != 'L' || record0[3] != 'E') { error = "$MFT is unreadable."; return false; }
            ApplyFixup(record0, 0, (int)recordSize);
            long mftBytes = 0, mftAllocated = 0;
            var runs = new List<long[]>();
            int pos = BitConverter.ToUInt16(record0, 0x14);
            while (pos + 16 <= (int)recordSize)
            {
                uint type = BitConverter.ToUInt32(record0, pos);
                if (type == 0xffffffffu) break;
                int len = BitConverter.ToInt32(record0, pos + 4);
                if (len < 16 || pos + len > (int)recordSize) break;
                if (type == 0x80 && record0[pos + 9] == 0)
                {
                    mftBytes = BitConverter.ToInt64(record0, pos + 0x30);
                    mftAllocated = BitConverter.ToInt64(record0, pos + 0x38);
                    ParseRuns(record0, pos + BitConverter.ToUInt16(record0, pos + 0x20), (int)recordSize, clusterBytes, runs);
                    break;
                }
                pos += len;
            }
            if (mftBytes <= 0 || runs.Count == 0) { error = "$MFT layout is unsupported."; return false; }
            // The run list is authoritative: its lengths must add up to the
            // allocated size the attribute header reports. Any parse that
            // produces more (or less) is corrupt — refuse rather than read
            // garbage offsets past the volume end.
            long runSum = 0;
            foreach (long[] run in runs) runSum += run[1];
            if (runSum != mftAllocated) { error = "$MFT run list does not match its size (" + runSum + " of " + mftAllocated + " bytes)."; return false; }
            if (VolDebug) Console.Error.WriteLine("VOLDBG hdr clusterBytes=" + clusterBytes + " recordSize=" + recordSize
                + " mftBytes=" + mftBytes + " mftAllocated=" + mftAllocated + " runs=" + runs.Count + " runSum=" + runSum);
#if WALKTRACE
            Console.Error.WriteLine("MFT clusterBytes=" + clusterBytes + " recordSize=" + recordSize + " mftBytes=" + mftBytes
                + " runs=" + runs.Count + " firstRun=" + (runs.Count > 0 ? runs[0][2] : 0) + " lastRun=" + (runs.Count > 0 ? runs[runs.Count - 1][2] : 0));
            foreach (long[] run in runs)
                Console.Error.WriteLine("RUN offsetInMft=" + run[0] + " lengthBytes=" + run[1] + " lcnByte=" + run[2]);
            {
                int attrPos = -1;
                int scanPos = BitConverter.ToUInt16(record0, 0x14);
                while (scanPos + 16 <= (int)recordSize)
                {
                    uint t = BitConverter.ToUInt32(record0, scanPos);
                    if (t == 0xffffffffu) break;
                    int l = BitConverter.ToInt32(record0, scanPos + 4);
                    if (l < 16 || scanPos + l > (int)recordSize) break;
                    Console.Error.WriteLine("ATTR type=0x" + t.ToString("x") + " len=" + l + " nonResident=" + record0[scanPos + 8]
                        + " nameLen=" + record0[scanPos + 9] + " runOff=" + BitConverter.ToUInt16(record0, scanPos + 0x20)
                        + " realSize=" + (t == 0x80 ? BitConverter.ToInt64(record0, scanPos + 0x30) : 0)
                        + " allocSize=" + (t == 0x80 ? BitConverter.ToInt64(record0, scanPos + 0x38) : 0));
                    if (t == 0x80) attrPos = scanPos;
                    scanPos += l;
                }
                if (attrPos >= 0)
                {
                    int runStart = attrPos + BitConverter.ToUInt16(record0, attrPos + 0x20);
                    var hex = new System.Text.StringBuilder();
                    for (int i = runStart; i < Math.Min(attrPos + 168 + 32, (int)recordSize); i++)
                        hex.Append(record0[i].ToString("x2")).Append(' ');
                    Console.Error.WriteLine("RUNLIST bytes from " + runStart + ": " + hex);
                }
            }
#endif
            volRecordCount = (int)(mftBytes / recordSize);
            if (volRecordCount < 24 || volRecordCount > 0x20000000) { error = "Drive too large for fast scanning."; return false; }
            volParent = new int[volRecordCount];
            volSize = new long[volRecordCount];
            volModified = new long[volRecordCount];
            volKind = new byte[volRecordCount];
            volFlags = new byte[volRecordCount];
            volName = new string[volRecordCount];
            var extensionRecords = new HashSet<int>();
            var buffer = new byte[32 << 20];
            foreach (long[] run in runs)
            {
                long startByte = run[0], lengthBytes = run[1], lcnByte = run[2];
                if (lcnByte < 0) { if (VolDebug) Console.Error.WriteLine("VOLDBG run off=" + startByte + " len=" + lengthBytes + " SPARSE"); continue; }            // sparse zone: no records
                long dbgBefore = dbgParsed;
                long done = 0;
                while (done < lengthBytes)
                {
                    int chunk = (int)Math.Min(buffer.Length, lengthBytes - done);
                    chunk -= chunk % (int)recordSize;
                    if (chunk <= 0) break;
                    if (!ReadAt(handle, buffer, lcnByte + done, chunk))
                    {
                        error = "$MFT could not be read (Win32 error " + Marshal.GetLastWin32Error() + " at offset " + (lcnByte + done) + ").";
                        return false;
                    }
                    for (int offset = 0; offset + recordSize <= chunk; offset += (int)recordSize)
                    {
                        int recNum = (int)((startByte + done + offset) / recordSize);
                        ParseVolumeRecord(buffer, offset, (int)recordSize, recNum, extensionRecords);
                    }
                    done += chunk;
                }
                if (VolDebug) Console.Error.WriteLine("VOLDBG run off=" + startByte + " len=" + lengthBytes + " lcnByte=" + lcnByte + " parsed=" + (dbgParsed - dbgBefore));
            }
            foreach (int extent in extensionRecords)
                if (extent >= 0 && extent < volRecordCount) { volKind[extent] = 0; volName[extent] = null; }
            dbgExtZeroed = extensionRecords.Count;
            if (VolDebug) Console.Error.WriteLine("VOLDBG parse magic=" + dbgMagic + " fixup=" + dbgFixup + " notInUse=" + dbgNotInUse
                + " noName=" + dbgNoName + " meta=" + dbgMeta + " badParent=" + dbgBadParent + " self=" + dbgSelf
                + " parsed=" + dbgParsed + " extZeroed=" + dbgExtZeroed);
            BuildVolumeChildren();
            return true;
        }
        finally { CloseHandle(handle); }
    }

    private static void WriteAdmin(string path)
    {
        IntPtr handle = OpenVolumeHandle(path);
        bool admin = handle != Invalid;
        bool ntfs = false;
        if (admin)
        {
            try
            {
                var boot = new byte[512];
                if (ReadAt(handle, boot, 0, 512)) ntfs = boot[3] == 'N' && boot[4] == 'T' && boot[5] == 'F' && boot[6] == 'S';
            }
            finally { CloseHandle(handle); }
        }
        Out.Length = 0;
        Out.Append("{\"admin\":").Append(admin ? "true" : "false");
        Out.Append(",\"ntfs\":").Append(ntfs ? "true" : "false").Append('}');
        Console.WriteLine(Out.ToString());
    }

    private static string RenderError(int index, int code)
    {
        var message = new StringBuilder(96);
        message.Append("{\"i\":").Append(index).Append(",\"e\":\"");
        foreach (char c in new Win32Exception(code).Message)
        {
            if (c == '"' || c == '\\') { message.Append('\\'); message.Append(c); }
            else if (c < ' ') message.Append(' ');
            else message.Append(c);
        }
        message.Append("\"}");
        return message.ToString();
    }

    private static string ParentPath(int index)
    {
        // Compose the full path by walking parents; depth is small.
        var parts = new List<string>();
        int cursor = index;
        while (cursor > 0) { parts.Add(walk[cursor].Name); cursor = walk[cursor].Parent; }
        string root = walk[0].Name;
        var builder = new StringBuilder(root);
        for (int i = parts.Count - 1; i >= 0; i--)
        {
            if (!builder.ToString().EndsWith("\\")) builder.Append('\\');
            builder.Append(parts[i]);
        }
        return builder.ToString();
    }

    private static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
        // Stop even if a network provider is blocked when the owning app exits.
        Timer watchdog = null;
        int parent;
        if (args.Length == 1 && Int32.TryParse(args[0], out parent))
        {
            var owner = Process.GetProcessById(parent);
            watchdog = new Timer(delegate {
                try { if (owner.HasExited) Environment.Exit(0); } catch { Environment.Exit(0); }
                // Also bound a blocked provider call after a worker is stopped
                // while its Electron process remains alive. Paused/idle is fine.
                // A volume request loads and parses the whole Master File Table
                // in one go, so it earns a much longer bound.
                long started = Interlocked.Read(ref requestStarted);
                long bound = (System.Threading.Volatile.Read(ref volumeRequest) ? 900L : 35L) * Stopwatch.Frequency;
                if (started != 0 && Stopwatch.GetTimestamp() - started > bound) Environment.Exit(1);
            }, null, 1000, 1000);
        }
        var json = new JavaScriptSerializer();
        try
        {
            Console.WriteLine("{\"ready\":1}");
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                string op = Convert.ToString(request["op"]);
                if (op == "close") break;
                // Demand-driven batching already stops the helper when the
                // caller stops reading; pause/resume only need acknowledging.
                if (op == "pause" || op == "resume") continue;
                if (op == "admin")
                {
                    WriteAdmin(Convert.ToString(request.ContainsKey("path") ? request["path"] : "C:\\"));
                    continue;
                }
                if (op != "open" && op != "next" && op != "volume") throw new InvalidOperationException("Unknown request");
                volumeRequest = op == "volume";
                Interlocked.Exchange(ref requestStarted, Stopwatch.GetTimestamp());
                var excludeList = new List<string>();
                if (request.ContainsKey("x"))
                {
                    // JavaScriptSerializer hands arrays back as ArrayList, so
                    // the enumeration must be non-generic here.
                    var rawList = request["x"] as System.Collections.IEnumerable;
                    if (rawList != null) foreach (object item in rawList) excludeList.Add(Convert.ToString(item));
                }
                if (volumeRequest) WriteVolumeBatch(Convert.ToString(request["path"]), excludeList);
                else WriteBatch(op == "open" ? Convert.ToString(request["path"]) : null, excludeList);
                Interlocked.Exchange(ref requestStarted, 0);
            }
        }
        finally { Close(); if (watchdog != null) watchdog.Dispose(); }
    }
}
