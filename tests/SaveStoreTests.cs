using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using PathOfKungFuSaveEditor;

internal static class SaveStoreTests
{
    private static int _passed;
    private static int _failed;

    private static int Main()
    {
        try
        {
            Run("Test1_RoundtripAndLeb128", Test1_RoundtripAndLeb128);
            Run("Test2_RejectInvalid", Test2_RejectInvalid);
            Run("Test3_BackupAndRestore", Test3_BackupAndRestore);
            Run("Test4_SimulateGameRunning", Test4_SimulateGameRunning);
            Run("Test5_JunctionRejected", Test5_JunctionRejected);
            Run("Test6_AdsAndReserved", Test6_AdsAndReserved);
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FAIL] Unexpected top-level exception: " + ex);
            _failed++;
        }

        Console.WriteLine();
        Console.WriteLine("Passed: " + _passed.ToString(CultureInfo.InvariantCulture));
        Console.WriteLine("Failed: " + _failed.ToString(CultureInfo.InvariantCulture));
        return _failed == 0 ? 0 : 1;
    }

    private static void Run(string name, Action test)
    {
        Console.WriteLine();
        Console.WriteLine("=== " + name + " ===");
        int beforeFailed = _failed;
        try
        {
            test();
        }
        catch (Exception ex)
        {
            _failed++;
            Console.WriteLine("[FAIL] " + name + " threw exception: " + ex);
        }

        if (_failed == beforeFailed)
        {
            _passed++;
            Console.WriteLine("[PASS] " + name);
        }
        else
        {
            Console.WriteLine("[FAIL] " + name);
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception("Assertion failed: " + message);
    }

    private static void AssertThrows<T>(Action action, string message) where T : Exception
    {
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }
        catch (Exception ex)
        {
            throw new Exception("Expected " + typeof(T).Name + " but got " + ex.GetType().Name + ": " + ex.Message);
        }

        throw new Exception("Expected " + typeof(T).Name + " but no exception was thrown. " + message);
    }

    private static string MakeTempRoot(string testName)
    {
        string root = Path.Combine(Path.GetTempPath(), "SaveStoreTests_" + testName + "_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static void CleanupDirectory(string dir)
    {
        if (dir == null) return;
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        catch { }
    }

    private static string MakeValidJson()
    {
        return "{\"firstName\":\"무명\",\"lastName\":\"협객\",\"sliver\":123,\"attribute\":3,\"gameLv\":1}";
    }

    private static string MakeValidJson2()
    {
        return "{\"firstName\":\"영웅\",\"lastName\":\"강호\",\"sliver\":456,\"attribute\":4,\"gameLv\":2}";
    }

    private static string MakeValidJsonWithSliver(int sliver)
    {
        return "{\"firstName\":\"무명\",\"sliver\":" + sliver.ToString(CultureInfo.InvariantCulture) + ",\"attribute\":1,\"gameLv\":1}";
    }

    private static string MakeValidJsonWithAttribute(int attribute)
    {
        return "{\"firstName\":\"무명\",\"sliver\":1,\"attribute\":" + attribute.ToString(CultureInfo.InvariantCulture) + ",\"gameLv\":1}";
    }

    private static string MakeValidJsonWithGameLv(int gameLv)
    {
        return "{\"firstName\":\"무명\",\"sliver\":1,\"attribute\":1,\"gameLv\":" + gameLv.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static byte[] Deflate(byte[] input)
    {
        using (MemoryStream output = new MemoryStream())
        {
            using (DeflateStream deflate = new DeflateStream(output, CompressionMode.Compress, true))
            {
                deflate.Write(input, 0, input.Length);
            }
            return output.ToArray();
        }
    }

    private static byte[] Inflate(byte[] input)
    {
        using (MemoryStream ms = new MemoryStream(input))
        using (DeflateStream deflate = new DeflateStream(ms, CompressionMode.Decompress))
        using (MemoryStream output = new MemoryStream())
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = deflate.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }

    private static byte[] WriteLeb128(ulong value)
    {
        List<byte> bytes = new List<byte>();
        do
        {
            byte b = (byte)(value & 0x7F);
            value >>= 7;
            if (value != 0) b |= 0x80;
            bytes.Add(b);
        }
        while (value != 0);
        return bytes.ToArray();
    }

    private static ulong ReadLeb128(byte[] data, ref int offset)
    {
        ulong value = 0;
        int shift = 0;
        while (true)
        {
            if (offset >= data.Length) throw new InvalidDataException("Truncated LEB128.");
            byte b = data[offset++];
            value |= (ulong)(b & 0x7F) << shift;
            if ((b & 0x80) == 0) return value;
            shift += 7;
            if (shift >= 64) throw new InvalidDataException("LEB128 too long.");
        }
    }

    private static byte[] Concat(params byte[][] parts)
    {
        int length = 0;
        int i;
        for (i = 0; i < parts.Length; i++) length += parts[i].Length;
        byte[] result = new byte[length];
        int pos = 0;
        for (i = 0; i < parts.Length; i++)
        {
            Buffer.BlockCopy(parts[i], 0, result, pos, parts[i].Length);
            pos += parts[i].Length;
        }
        return result;
    }

    private static string Sha256Hex(byte[] data)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(data);
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }

    private static string Sha256File(string path)
    {
        return Sha256Hex(File.ReadAllBytes(path));
    }

    private static void Test1_RoundtripAndLeb128()
    {
        string json = MakeValidJson();
        SaveStore.ValidateSaveJson(json);

        byte[] encoded = SaveStore.EncodeSaveBytes("1", json);
        Assert(encoded != null && encoded.Length > 0, "EncodeSaveBytes returned empty data.");

        string expectedKey = "KeyPlayerDatammjh20231";
        int offset = 0;
        ulong keyLen = ReadLeb128(encoded, ref offset);
        Assert(keyLen == (ulong)Encoding.UTF8.GetByteCount(expectedKey), "LEB128 key length mismatch.");
        string key = Encoding.UTF8.GetString(encoded, offset, checked((int)keyLen));
        offset += checked((int)keyLen);
        Assert(key == expectedKey, "Encoded key mismatch: " + key);

        ulong compressedLen = ReadLeb128(encoded, ref offset);
        Assert(compressedLen > 0, "Compressed length must be positive.");
        Assert((ulong)(encoded.Length - offset) == compressedLen, "Compressed length does not match remaining bytes.");

        byte[] compressed = new byte[checked((int)compressedLen)];
        Buffer.BlockCopy(encoded, offset, compressed, 0, compressed.Length);
        byte[] inflated = Inflate(compressed);
        Assert(Encoding.UTF8.GetString(inflated) == json, "Deflated payload did not roundtrip to the original JSON.");

        string decodedJson = Encoding.UTF8.GetString(SaveStore.DecodeSaveBytes(encoded));
        Assert(decodedJson == json, "DecodeSaveBytes(byte[]) returned mismatched JSON.");

        byte[] utf16Payload = Encoding.Unicode.GetBytes(json);
        byte[] utf16Comp = Deflate(utf16Payload);
        byte[] wrappedBinary = Concat(
            WriteLeb128((ulong)Encoding.UTF8.GetByteCount(expectedKey)),
            Encoding.UTF8.GetBytes(expectedKey),
            WriteLeb128((ulong)utf16Comp.Length),
            utf16Comp);

        string decodedUtf16 = Encoding.UTF8.GetString(SaveStore.DecodeSaveBytes(wrappedBinary));
        Assert(decodedUtf16 == json, "UTF-16LE deflated payload did not decode cleanly.");

        string saveKey;
        string slotId;
        string decodedWithInfo = SaveStore.DecodeSaveBytes(encoded, out saveKey, out slotId);
        Assert(decodedWithInfo == json, "DecodeSaveBytes(raw, out key, out slot) returned mismatched JSON.");
        Assert(saveKey == expectedKey, "Decoded saveKey mismatch.");
        Assert(slotId == "1", "Decoded slotId mismatch.");
    }

    private static void Test2_RejectInvalid()
    {
        AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveJson(MakeValidJsonWithSliver(-1)); }, "negative sliver");
        AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveJson(MakeValidJsonWithAttribute(99)); }, "out-of-range attribute 99");
        AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveJson(MakeValidJsonWithGameLv(5)); }, "out-of-range gameLv 5");

        string trailingGarbage = MakeValidJson() + " trailing";
        AssertThrows<InvalidDataException>(delegate { SaveStore.ValidateSaveJson(trailingGarbage); }, "trailing garbage after JSON object");

        string wrongKey = "WrongKey1";
        byte[] wrongKeyBytes = Deflate(Encoding.UTF8.GetBytes(MakeValidJson()));
        byte[] wrongKeySave = Concat(
            WriteLeb128((ulong)Encoding.UTF8.GetByteCount(wrongKey)),
            Encoding.UTF8.GetBytes(wrongKey),
            WriteLeb128((ulong)wrongKeyBytes.Length),
            wrongKeyBytes);
        AssertThrows<InvalidDataException>(delegate { SaveStore.DecodeSaveBytes(wrongKeySave); }, "wrong key prefix");

        byte[] good = SaveStore.EncodeSaveBytes("1", MakeValidJson());
        byte[] truncated = new byte[good.Length - 3];
        Buffer.BlockCopy(good, 0, truncated, 0, truncated.Length);
        AssertThrows<InvalidDataException>(delegate { SaveStore.DecodeSaveBytes(truncated); }, "truncated binary save");

        byte[] trailingBytes = new byte[good.Length + 4];
        Buffer.BlockCopy(good, 0, trailingBytes, 0, good.Length);
        trailingBytes[good.Length] = 0x41;
        trailingBytes[good.Length + 1] = 0x42;
        trailingBytes[good.Length + 2] = 0x43;
        trailingBytes[good.Length + 3] = 0x44;
        AssertThrows<InvalidDataException>(delegate { SaveStore.DecodeSaveBytes(trailingBytes); }, "trailing bytes after deflate payload");
    }

    private static void Test3_BackupAndRestore()
    {
        string root = MakeTempRoot("Test3_BackupAndRestore");
        try
        {
            string target = Path.Combine(root, "PlayerData_1.save");
            SaveWriteResult result1 = SaveStore.SaveWithBackup(target, MakeValidJson(), "1");
            Assert(result1 != null && File.Exists(target), "Initial save failed.");
            byte[] originalBytes = File.ReadAllBytes(target);
            string originalHash = Sha256Hex(originalBytes);

            SaveStore.SaveWithBackup(target, MakeValidJson2(), "1");
            Assert(Sha256File(target) != originalHash, "Second save did not change target contents.");

            string backupsDir = Path.Combine(root, "backups");
            Assert(Directory.Exists(backupsDir), "Backups directory was not created.");
            string[] bakFiles = Directory.GetFiles(backupsDir, "*.bak", SearchOption.AllDirectories);
            Assert(bakFiles.Length > 0, "No .bak file found.");

            string chosenBak = null;
            for (int i = 0; i < bakFiles.Length; i++)
            {
                if (Sha256File(bakFiles[i]) == originalHash) { chosenBak = bakFiles[i]; break; }
            }
            Assert(chosenBak != null, "No .bak file matched original SHA-256.");

            SaveStore.RestoreBackup(chosenBak, target);
            Assert(Sha256File(target) == originalHash, "RestoreBackup did not restore exact original bytes.");
        }
        finally
        {
            CleanupDirectory(root);
        }
    }

    private static void Test4_SimulateGameRunning()
    {
        string root = MakeTempRoot("Test4_SimulateGameRunning");
        string oldValue = Environment.GetEnvironmentVariable("POKF_SIMULATE_GAME_RUNNING");
        try
        {
            string target = Path.Combine(root, "PlayerData_1.save");
            SaveStore.SaveWithBackup(target, MakeValidJson(), "1");
            string originalHash = Sha256File(target);

            Environment.SetEnvironmentVariable("POKF_SIMULATE_GAME_RUNNING", "1");

            bool threw = false;
            try { SaveStore.SaveWithBackup(target, MakeValidJson2(), "1"); }
            catch (Exception) { threw = true; }
            Assert(threw, "SaveWithBackup did not throw while POKF_SIMULATE_GAME_RUNNING=1.");
            Assert(Sha256File(target) == originalHash, "Target file changed after rejected save.");

            string[] pending = Directory.GetFiles(root, "*.pending-*.tmp", SearchOption.AllDirectories);
            Assert(pending.Length == 0, "Found pending temp files.");
        }
        finally
        {
            Environment.SetEnvironmentVariable("POKF_SIMULATE_GAME_RUNNING", oldValue);
            CleanupDirectory(root);
        }
    }

    private static void Test5_JunctionRejected()
    {
        string root = MakeTempRoot("Test5_JunctionRejected");
        string junction = Path.Combine(root, "junction");
        string realTarget = Path.Combine(root, "real");
        bool junctionCreated = false;
        try
        {
            Directory.CreateDirectory(realTarget);
            string innerFile = Path.Combine(realTarget, "file.txt");
            File.WriteAllText(innerFile, "real");

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = "/c mklink /J \"" + junction + "\" \"" + realTarget + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                    junctionCreated = p.ExitCode == 0 && Directory.Exists(junction);
                }
            }
            catch { junctionCreated = false; }

            if (!junctionCreated)
            {
                SaveStore.NoLinks(realTarget);
                SaveStore.NoLinks(realTarget, true);
                Console.WriteLine("SKIP: Junction creation not permitted; real target accepted.");
                return;
            }

            string throughJunction = Path.Combine(junction, "file.txt");
            AssertThrows<Exception>(delegate { SaveStore.NoLinks(throughJunction); }, "junction path rejected");
            AssertThrows<Exception>(delegate { SaveStore.NoLinks(throughJunction, true); }, "junction path rejected with allowMissingLeaf");

            SaveStore.NoLinks(realTarget);
            SaveStore.NoLinks(realTarget, true);
        }
        finally
        {
            if (junctionCreated)
            {
                try
                {
                    ProcessStartInfo rmdir = new ProcessStartInfo("cmd.exe");
                    rmdir.Arguments = "/c rmdir \"" + junction + "\"";
                    rmdir.UseShellExecute = false;
                    rmdir.CreateNoWindow = true;
                    using (Process p = Process.Start(rmdir)) { p.WaitForExit(); }
                }
                catch { }
            }
            CleanupDirectory(root);
        }
    }

    private static void Test6_AdsAndReserved()
    {
        string root = MakeTempRoot("Test6_AdsAndReserved");
        try
        {
            Directory.CreateDirectory(root);
            AssertThrows<Exception>(delegate { SaveStore.NoLinks(Path.Combine(root, "foo.save:ads"), true); }, "ADS path");
            string[] reserved = new string[] { "CON.save", "NUL.save", "PRN.save", "AUX.save", "COM1.save", "LPT1.save" };
            for (int i = 0; i < reserved.Length; i++)
            {
                string p = Path.Combine(root, reserved[i]);
                File.WriteAllText(p, "x"); // Ensure exists so NoLinks checks filename segment
                AssertThrows<Exception>(delegate { SaveStore.NoLinks(p); }, "reserved name " + reserved[i]);
            }
        }
        finally
        {
            CleanupDirectory(root);
        }
    }
}
