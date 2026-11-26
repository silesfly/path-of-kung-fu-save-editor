using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

namespace PathOfKungFuSaveEditor
{
    public class SaveSlotInfo
    {
        public string FilePath { get; set; }
        public string SlotId { get; set; }
        public string Sha256 { get; set; }
        public string Summary { get; set; }
        public DateTime LastWriteUtc { get; set; }
    }

    public class BackupInfo
    {
        public string FilePath { get; set; }
        public string OriginalPath { get; set; }
        public string Sha256 { get; set; }
        public DateTime CreatedUtc { get; set; }
    }

    public class SaveWriteResult
    {
        public string Path { get; set; }
        public string Sha256 { get; set; }
        public string BackupPath { get; set; }
        public bool Overwrote { get; set; }
    }

    public class SaveLoadResult
    {
        public string Path { get; set; }
        public string JsonText { get; set; }
        public string SlotId { get; set; }
        public string SaveKey { get; set; }
        public string Sha256 { get; set; }
        public DateTime LastWriteUtc { get; set; }
    }

    public sealed class SaveStore
    {
        public const string SaveKeyPrefix = "KeyPlayerDatammjh2023";
        public const int MaxDecompressedBytes = 64 * 1024 * 1024;
        public const int MaxCompressedBytes = 64 * 1024 * 1024;
        public const int MaxBackups = 20;

        private static readonly Regex SlotIdRegex = new Regex(@"^\d+$", RegexOptions.Compiled);
        private static readonly Regex SaveKeyRegex = new Regex(@"^KeyPlayerDatammjh2023(\d+)$", RegexOptions.Compiled);
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);
        private static readonly UnicodeEncoding Utf16Le = new UnicodeEncoding(false, false, true);

        // Public API ---------------------------------------------------------

        public static List<string> DiscoverRoots()
        {
            List<string> roots = new List<string>();
            string env = Environment.GetEnvironmentVariable("POKF_SAVE_ROOT");
            if (!string.IsNullOrEmpty(env) && Directory.Exists(env))
            {
                AddUniquePath(roots, env);
            }

            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(userProfile))
            {
                string p1 = Path.Combine(userProfile, "AppData", "LocalLow", "HuaLongZ", "saves");
                string p2 = Path.Combine(userProfile, "AppData", "LocalLow", "HuaLongZ", "daojianjianghulu");
                if (Directory.Exists(p1)) AddUniquePath(roots, p1);
                if (Directory.Exists(p2)) AddUniquePath(roots, p2);
            }
            return roots;
        }

        public static List<SaveSlotInfo> ListSlots(string root)
        {
            if (root == null) throw new ArgumentNullException("root");
            List<SaveSlotInfo> result = new List<SaveSlotInfo>();
            List<string> dirs = new List<string>();
            if (Directory.Exists(root))
            {
                dirs.Add(root);
                string sub = Path.Combine(root, "saves");
                if (Directory.Exists(sub)) dirs.Add(sub);
            }
            foreach (string dir in dirs)
            {
                string[] files;
                try { files = Directory.GetFiles(dir, "PlayerData_*.save", SearchOption.TopDirectoryOnly); }
                catch (IOException) { continue; }
                catch (UnauthorizedAccessException) { continue; }

                foreach (string f in files)
                {
                    string name = Path.GetFileName(f);
                    if (name.StartsWith("ArchiveDataFenDang.json", StringComparison.OrdinalIgnoreCase)) continue;
                    if (name.StartsWith("Setting", StringComparison.OrdinalIgnoreCase)) continue;
                    if (name.EndsWith(".bak", StringComparison.OrdinalIgnoreCase)) continue;

                    SaveSlotInfo info = new SaveSlotInfo();
                    info.FilePath = f;
                    try
                    {
                        info.LastWriteUtc = File.GetLastWriteTimeUtc(f);
                        byte[] data = File.ReadAllBytes(f);
                        info.Sha256 = HashSha256(data);
                        string key;
                        string slotId;
                        try
                        {
                            string json = DecodeSaveBytes(data, out key, out slotId);
                            info.SlotId = slotId;
                            info.Summary = BuildSummary(json);
                        }
                        catch (Exception)
                        {
                            info.SlotId = null;
                            info.Summary = "(unreadable)";
                        }
                    }
                    catch (IOException)
                    {
                        info.Summary = "(io error)";
                    }
                    catch (UnauthorizedAccessException)
                    {
                        info.Summary = "(access denied)";
                    }
                    result.Add(info);
                }
            }
            return result;
        }

        public static SaveLoadResult LoadSlot(string path)
        {
            if (path == null) throw new ArgumentNullException("path");
            NoLinks(path, false);
            EnsureGameNotRunning();

            byte[] data = File.ReadAllBytes(path);
            string key;
            string slotId;
            string json = DecodeSaveBytes(data, out key, out slotId);

            SaveLoadResult res = new SaveLoadResult();
            res.Path = path;
            res.JsonText = json;
            res.SlotId = slotId;
            res.SaveKey = key;
            res.Sha256 = HashSha256(data);
            res.LastWriteUtc = File.GetLastWriteTimeUtc(path);
            return res;
        }

        public static SaveWriteResult SaveWithBackup(string targetPath, string jsonText, string slotId)
        {
            if (targetPath == null) throw new ArgumentNullException("targetPath");
            if (jsonText == null) throw new ArgumentNullException("jsonText");
            if (slotId == null) throw new ArgumentNullException("slotId");

            if (!SlotIdRegex.IsMatch(slotId))
                throw new ArgumentException("slotId must be composed of digits only.", "slotId");

            ValidateSaveJson(jsonText);
            byte[] encoded = EncodeSaveBytes(slotId, jsonText);
            return SaveWithBackup(targetPath, encoded);
        }

        public static SaveWriteResult SaveWithBackup(string targetPath, byte[] encoded)
        {
            if (targetPath == null) throw new ArgumentNullException("targetPath");
            if (encoded == null) throw new ArgumentNullException("encoded");

            NoLinks(targetPath, true);
            EnsureGameNotRunning();

            SaveWriteResult result = new SaveWriteResult();
            result.Path = targetPath;
            result.Sha256 = HashSha256(encoded);
            result.Overwrote = File.Exists(targetPath);

            string dir = Path.GetDirectoryName(targetPath);
            if (string.IsNullOrEmpty(dir))
                throw new InvalidOperationException("Target path has no directory.");

            string backupDir = Path.Combine(dir, "backups");
            string uid = Guid.NewGuid().ToString("N");

            if (File.Exists(targetPath))
            {
                byte[] original = File.ReadAllBytes(targetPath);
                string originalSha = HashSha256(original);

                NoLinks(dir, false);
                if (!Directory.Exists(backupDir))
                    Directory.CreateDirectory(backupDir);
                else
                    NoLinks(backupDir, false);

                string fname = Path.GetFileName(targetPath);
                string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
                string backupPath = Path.Combine(backupDir, fname + ".backup-" + stamp + "-" + uid.Substring(0, 8) + ".bak");
                backupPath = Path.Combine(dir, backupPath.Substring(dir.Length + 1)); // normalize

                byte[] copyForVerify = (byte[])original.Clone();
                File.WriteAllBytes(backupPath, copyForVerify);

                byte[] verify = File.ReadAllBytes(backupPath);
                string verifySha = HashSha256(verify);
                if (!string.Equals(verifySha, originalSha, StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Delete(backupPath); } catch (Exception) { }
                    throw new IOException("Backup verification failed.");
                }
                result.BackupPath = backupPath;
                PruneBackups(backupDir, fname);
            }

            string tmpPath = targetPath + ".pending-" + uid.Substring(0, 8) + ".tmp";
            string finalTarget = targetPath;

            try
            {
                File.WriteAllBytes(tmpPath, encoded);
                byte[] check = File.ReadAllBytes(tmpPath);
                if (check.Length != encoded.Length)
                    throw new IOException("Pending write size mismatch.");

                if (!MoveFileEx(tmpPath, finalTarget, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new IOException("MoveFileExW failed with error " + err.ToString(CultureInfo.InvariantCulture) + ".");
                }
            }
            catch (Exception)
            {
                if (File.Exists(tmpPath))
                {
                    try { File.Delete(tmpPath); }
                    catch (Exception) { }
                }
                throw;
            }

            return result;
        }

        public static List<BackupInfo> ListBackups(string root)
        {
            if (root == null) throw new ArgumentNullException("root");
            List<BackupInfo> result = new List<BackupInfo>();
            string backupDir = Path.Combine(root, "backups");
            if (!Directory.Exists(backupDir)) return result;

            string[] files;
            try { files = Directory.GetFiles(backupDir, "*.bak", SearchOption.TopDirectoryOnly); }
            catch (IOException) { return result; }
            catch (UnauthorizedAccessException) { return result; }

            foreach (string f in files)
            {
                try
                {
                    byte[] data = File.ReadAllBytes(f);
                    BackupInfo bi = new BackupInfo();
                    bi.FilePath = f;
                    bi.Sha256 = HashSha256(data);
                    bi.CreatedUtc = File.GetLastWriteTimeUtc(f);
                    string name = Path.GetFileName(f);
                    int idx = name.IndexOf(".backup-", StringComparison.OrdinalIgnoreCase);
                    bi.OriginalPath = idx > 0 ? Path.Combine(root, name.Substring(0, idx)) : null;
                    result.Add(bi);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            result.Sort(delegate(BackupInfo a, BackupInfo b) { return b.CreatedUtc.CompareTo(a.CreatedUtc); });
            return result;
        }

        public static void RestoreBackup(string backupPath, string targetPath)
        {
            if (backupPath == null) throw new ArgumentNullException("backupPath");
            if (targetPath == null) throw new ArgumentNullException("targetPath");

            NoLinks(backupPath, false);
            NoLinks(targetPath, true);
            EnsureGameNotRunning();

            byte[] backupData = File.ReadAllBytes(backupPath);
            string backupSha = HashSha256(backupData);

            // Validate the backup actually decodes cleanly.
            string key;
            string slotId;
            DecodeSaveBytes(backupData, out key, out slotId);

            string uid = Guid.NewGuid().ToString("N");
            string tmpPath = targetPath + ".pending-" + uid.Substring(0, 8) + ".tmp";

            try
            {
                File.WriteAllBytes(tmpPath, backupData);
                byte[] check = File.ReadAllBytes(tmpPath);
                if (!string.Equals(HashSha256(check), backupSha, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Restore write verification failed.");

                if (!MoveFileEx(tmpPath, targetPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new IOException("MoveFileExW failed with error " + err.ToString(CultureInfo.InvariantCulture) + ".");
                }
            }
            catch (Exception)
            {
                if (File.Exists(tmpPath))
                {
                    try { File.Delete(tmpPath); }
                    catch (Exception) { }
                }
                throw;
            }
        }

        // Codec --------------------------------------------------------------

        private static int Read7BitInt(Stream s)
        {
            int result = 0;
            for (int i = 0, shift = 0; i < 5; i++, shift += 7)
            {
                int b = s.ReadByte();
                if (b < 0) throw new EndOfStreamException("Missing compressed length.");
                if (i == 4 && (b & 0xF0) != 0) throw new InvalidDataException("Invalid 7-bit length.");
                result |= (b & 0x7F) << shift;
                if ((b & 0x80) == 0)
                {
                    if (result < 0) throw new InvalidDataException("Negative 7-bit length.");
                    return result;
                }
            }
            throw new InvalidDataException("7-bit length too long.");
        }

        private static void Write7BitInt(Stream s, int value)
        {
            if (value < 0) throw new ArgumentOutOfRangeException("value");
            uint v = (uint)value;
            while (v >= 0x80)
            {
                s.WriteByte((byte)(v | 0x80));
                v >>= 7;
            }
            s.WriteByte((byte)v);
        }

        public static byte[] DecodeSaveBytes(byte[] raw)
        {
            string k;
            string s;
            return Utf8NoBom.GetBytes(DecodeSaveBytes(raw, out k, out s));
        }

        public static string DecodeSaveBytes(byte[] raw, out string saveKey, out string slotId)
        {
            if (raw == null) throw new ArgumentNullException("raw");
            if (raw.Length < 4) throw new InvalidDataException("Save file too short.");

            using (MemoryStream stream = new MemoryStream(raw, false))
            using (BinaryReader reader = new BinaryReader(stream, Utf8NoBom, true))
            {
                try { saveKey = reader.ReadString(); }
                catch (EndOfStreamException) { throw new InvalidDataException("Missing save key header."); }
                Match m = SaveKeyRegex.Match(saveKey);
                if (!m.Success)
                    throw new InvalidDataException("Unexpected save key header.");
                slotId = m.Groups[1].Value;

                int compLen;
                try { compLen = Read7BitInt(stream); }
                catch (EndOfStreamException)
                {
                    throw new InvalidDataException("Missing compressed length.");
                }

                if (compLen <= 0 || compLen > MaxCompressedBytes)
                    throw new InvalidDataException("Compressed length out of range.");

                long pos = stream.Position;
                if (pos + compLen != stream.Length)
                    throw new InvalidDataException("Compressed length does not match file size.");

                byte[] comp = reader.ReadBytes(compLen);
                if (comp.Length != compLen)
                    throw new InvalidDataException("Truncated compressed payload.");

                byte[] plain = DecompressDeflate(comp, MaxDecompressedBytes);

                string json = null;
                try
                {
                    string s = StrictUtf8.GetString(plain);
                    VerifyJsonRoot(s);
                    json = s;
                }
                catch (Exception)
                {
                    try
                    {
                        string s2 = Utf16Le.GetString(plain);
                        VerifyJsonRoot(s2);
                        json = s2;
                    }
                    catch (Exception)
                    {
                        throw new InvalidDataException("Save payload is not valid UTF-8/UTF-16 JSON.");
                    }
                }
                return json;
            }
        }

        public static byte[] EncodeSaveBytes(string slotId, string jsonText)
        {
            if (slotId == null) throw new ArgumentNullException("slotId");
            if (jsonText == null) throw new ArgumentNullException("jsonText");
            if (!SlotIdRegex.IsMatch(slotId))
                throw new ArgumentException("slotId must be composed of digits only.", "slotId");

            ValidateSaveJson(jsonText);

            byte[] plain = Utf8NoBom.GetBytes(jsonText);
            byte[] comp = CompressDeflate(plain);

            using (MemoryStream ms = new MemoryStream())
            {
                using (BinaryWriter writer = new BinaryWriter(ms, Utf8NoBom, true))
                {
                    writer.Write(SaveKeyPrefix + slotId);
                    writer.Flush();
                }
                Write7BitInt(ms, comp.Length);
                ms.Write(comp, 0, comp.Length);
                return ms.ToArray();
            }
        }

        public static byte[] EncodeSaveBytes(byte[] plainBytes)
        {
            if (plainBytes == null) throw new ArgumentNullException("plainBytes");
            string json = null;
            try
            {
                json = StrictUtf8.GetString(plainBytes);
                ValidateSaveJson(json);
            }
            catch (Exception)
            {
                json = Utf16Le.GetString(plainBytes);
                ValidateSaveJson(json);
            }
            return EncodeSaveBytes("1", json);
        }

        public static void ValidateSaveJson(string jsonText)
        {
            if (jsonText == null) throw new ArgumentNullException("jsonText");
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = MaxDecompressedBytes;

            object root;
            try { root = ser.DeserializeObject(jsonText); }
            catch (Exception ex)
            {
                throw new InvalidDataException("Save JSON could not be parsed: " + ex.Message, ex);
            }

            Dictionary<string, object> dict = root as Dictionary<string, object>;
            if (dict == null)
                throw new InvalidDataException("Save JSON root must be an object.");

            CheckNonNegative(dict, "sliver");
            CheckNonNegative(dict, "gold");
            CheckNonNegative(dict, "sectcoin");
            CheckNonNegative(dict, "gangCoin");
            CheckNonNegative(dict, "xiuWei");
            CheckNonNegative(dict, "ArrestNum");

            CheckRange(dict, "attribute", 0, 50);
            CheckRange(dict, "gameLv", 0, 10);
        }

        public static void NoLinks(string path)
        {
            NoLinks(path, false);
        }

        public static void NoLinks(string path, bool allowMissingLeaf)
        {
            if (path == null) throw new ArgumentNullException("path");
            if (path.Length == 0) throw new ArgumentException("Empty path.", "path");

            string full;
            try { full = Path.GetFullPath(path); }
            catch (Exception ex) { throw new InvalidOperationException("Invalid path.", ex); }

            if (HasInvalidColon(full))
                throw new InvalidOperationException("Path contains an invalid colon.");

            string root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root))
                throw new InvalidOperationException("Path has no drive root.");

            string[] segments = full.Substring(root.Length).Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            string current = root;

            for (int i = 0; i < segments.Length; i++)
            {
                current = Path.Combine(current, segments[i]);
                bool isLeaf = (i == segments.Length - 1);
                bool exists = Directory.Exists(current) || File.Exists(current);

                if (!exists)
                {
                    if (isLeaf && allowMissingLeaf) break;
                    if (isLeaf && allowMissingLeaf) break;
                    throw new FileNotFoundException("Path component missing.", current);
                }

                if (IsReservedDeviceName(segments[i]))
                    throw new InvalidOperationException("Reserved device name in path: " + segments[i]);

                VerifyNoReparsePoint(current);
            }
        }

        public static void EnsureGameNotRunning()
        {
            if (string.Equals(Environment.GetEnvironmentVariable("POKF_SIMULATE_GAME_RUNNING"), "1", StringComparison.Ordinal))
                throw new IOException("Game is running (simulated). Close it before editing saves.");

            Process[] procs;
            try { procs = Process.GetProcessesByName("daojianjianghulu"); }
            catch (Exception) { procs = new Process[0]; }

            if (procs != null && procs.Length > 0)
            {
                foreach (Process p in procs)
                {
                    try { p.Dispose(); }
                    catch (Exception) { }
                }
                throw new IOException("Game is running. Close daojianjianghulu before editing saves.");
            }
        }

        // Helpers ------------------------------------------------------------

        private static void AddUniquePath(List<string> roots, string p)
        {
            string full = p;
            try { full = Path.GetFullPath(p); }
            catch (Exception) { return; }
            foreach (string r in roots)
            {
                if (string.Equals(r, full, StringComparison.OrdinalIgnoreCase)) return;
            }
            roots.Add(full);
        }

        private static void VerifyJsonRoot(string s)
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = MaxDecompressedBytes;
            object root = ser.DeserializeObject(s);
            if (!(root is Dictionary<string, object>))
                throw new InvalidDataException("JSON root is not an object.");
        }

        private static string BuildSummary(string json)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = MaxDecompressedBytes;
                Dictionary<string, object> root = ser.DeserializeObject(json) as Dictionary<string, object>;
                if (root == null) return "(no root)";

                string first = GetStr(root, "firstName");
                string last = GetStr(root, "lastName");
                string name = (first + " " + last).Trim();
                if (name.Length == 0) name = "?";

                long sliver = GetLong(root, "sliver");
                long gold = GetLong(root, "gold");
                long attr = GetLong(root, "attribute");
                return name + " | sliver=" + sliver.ToString(CultureInfo.InvariantCulture)
                    + " gold=" + gold.ToString(CultureInfo.InvariantCulture)
                    + " attr=" + attr.ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return "(summary failed)";
            }
        }

        private static string GetStr(Dictionary<string, object> root, string key)
        {
            object v;
            if (!root.TryGetValue(key, out v) || v == null) return string.Empty;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        private static long GetLong(Dictionary<string, object> root, string key)
        {
            object v;
            if (!root.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); }
            catch (Exception) { return 0; }
        }

        private static void CheckNonNegative(Dictionary<string, object> dict, string key)
        {
            object v;
            if (!dict.TryGetValue(key, out v) || v == null) return;
            long n;
            try { n = Convert.ToInt64(v, CultureInfo.InvariantCulture); }
            catch (Exception)
            {
                throw new InvalidDataException("Field '" + key + "' is not an integer.");
            }
            if (n < 0) throw new InvalidDataException("Field '" + key + "' is negative.");
        }

        private static void CheckRange(Dictionary<string, object> dict, string key, long min, long max)
        {
            object v;
            if (!dict.TryGetValue(key, out v) || v == null) return;
            long n;
            try { n = Convert.ToInt64(v, CultureInfo.InvariantCulture); }
            catch (Exception)
            {
                throw new InvalidDataException("Field '" + key + "' is not an integer.");
            }
            if (n < min || n > max)
                throw new InvalidDataException("Field '" + key + "' is out of range [" + min.ToString(CultureInfo.InvariantCulture) + ".." + max.ToString(CultureInfo.InvariantCulture) + "].");
        }

        private static byte[] DecompressDeflate(byte[] comp, int maxBytes)
        {
            using (MemoryStream input = new MemoryStream(comp, false))
            using (DeflateStream deflate = new DeflateStream(input, CompressionMode.Decompress))
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                int total = 0;
                int read;
                while ((read = deflate.Read(buffer, 0, buffer.Length)) > 0)
                {
                    total += read;
                    if (total > maxBytes)
                        throw new InvalidDataException("Decompressed payload exceeds limit.");
                    output.Write(buffer, 0, read);
                }
                return output.ToArray();
            }
        }

        private static byte[] CompressDeflate(byte[] plain)
        {
            using (MemoryStream output = new MemoryStream())
            {
                using (DeflateStream deflate = new DeflateStream(output, CompressionMode.Compress, true))
                {
                    deflate.Write(plain, 0, plain.Length);
                }
                return output.ToArray();
            }
        }

        private static string HashSha256(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(data);
                StringBuilder sb = new StringBuilder(h.Length * 2);
                for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        private static bool HasInvalidColon(string path)
        {
            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] == ':')
                {
                    // Only allowed as a drive designator at position 1.
                    if (i != 1) return true;
                    char c = path[0];
                    bool isDrive = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
                    if (!isDrive) return true;
                }
            }
            return false;
        }

        private static bool IsReservedDeviceName(string name)
        {
            if (name == null || name.Length == 0) return false;
            string bare = name;
            int dot = bare.IndexOf('.');
            if (dot >= 0) bare = bare.Substring(0, dot);
            bare = bare.TrimEnd(' ');

            string upper = bare.ToUpperInvariant();
            if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL") return true;
            if (upper.Length == 4)
            {
                if (upper.StartsWith("COM", StringComparison.Ordinal) || upper.StartsWith("LPT", StringComparison.Ordinal))
                {
                    char d = upper[3];
                    return d >= '1' && d <= '9';
                }
            }
            return false;
        }

        // Win32 --------------------------------------------------------------

        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint GENERIC_READ = 0x80000000;
        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileEx(
            string lpExistingFileName,
            string lpNewFileName,
            uint dwFlags);

        private static void VerifyNoReparsePoint(string path)
        {
            SafeFileHandle h = CreateFileW(
                path,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                IntPtr.Zero);

            if (h.IsInvalid)
            {
                int err = Marshal.GetLastWin32Error();
                throw new IOException("Unable to open handle for '" + path + "' (error " + err.ToString(CultureInfo.InvariantCulture) + ").");
            }

            try
            {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(h, out info))
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new IOException("GetFileInformationByHandle failed (error " + err.ToString(CultureInfo.InvariantCulture) + ").");
                }

                if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                    throw new InvalidOperationException("Reparse points are not allowed: " + path);

                if (info.NumberOfLinks > 1)
                    throw new InvalidOperationException("Hard links are not allowed: " + path);

                StringBuilder sb = new StringBuilder(1024);
                uint len = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
                if (len == 0)
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new IOException("GetFinalPathNameByHandleW failed (error " + err.ToString(CultureInfo.InvariantCulture) + ").");
                }
                if (len >= sb.Capacity)
                {
                    sb = new StringBuilder((int)len + 1);
                    len = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
                    if (len == 0 || len >= sb.Capacity)
                        throw new IOException("GetFinalPathNameByHandleW failed (buffer).");
                }

                string finalPath = sb.ToString();
                if (finalPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("UNC paths are not allowed: " + finalPath);

                string canonical = finalPath;
                if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal))
                    canonical = canonical.Substring(4);

                string expected;
                try { expected = Path.GetFullPath(path); }
                catch (Exception) { expected = path; }
                if (expected.StartsWith(@"\\?\", StringComparison.Ordinal))
                    expected = expected.Substring(4);

                if (!string.Equals(NormalizeForCompare(canonical), NormalizeForCompare(expected), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Path canonicalization mismatch for '" + path + "' -> '" + canonical + "'.");
            }
            finally
            {
                h.Dispose();
            }
        }

        private static string NormalizeForCompare(string p)
        {
            if (string.IsNullOrEmpty(p)) return p;
            p = p.Replace('/', '\\');
            while (p.Length > 1 && p[p.Length - 1] == '\\') p = p.Substring(0, p.Length - 1);
            return p;
        }

        private static void PruneBackups(string backupDir, string originalFileName)
        {
            string[] backups;
            try { backups = Directory.GetFiles(backupDir, originalFileName + ".backup-*.bak", SearchOption.TopDirectoryOnly); }
            catch (Exception) { return; }

            List<KeyValuePair<DateTime, string>> entries = new List<KeyValuePair<DateTime, string>>();
            foreach (string f in backups)
            {
                try { entries.Add(new KeyValuePair<DateTime, string>(File.GetLastWriteTimeUtc(f), f)); }
                catch (Exception) { }
            }
            entries.Sort(delegate(KeyValuePair<DateTime, string> a, KeyValuePair<DateTime, string> b)
            {
                return b.Key.CompareTo(a.Key);
            });

            for (int i = MaxBackups; i < entries.Count; i++)
            {
                try { File.Delete(entries[i].Value); }
                catch (Exception) { }
            }
        }
    }
}
