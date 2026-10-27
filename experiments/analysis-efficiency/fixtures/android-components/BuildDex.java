import com.android.tools.smali.smali.Smali;
import com.android.tools.smali.smali.SmaliOptions;
import java.util.List;

/** Assemble the local fixture without Smali CLI's optional JCommander dependency. */
class BuildDex {
  public static void main(String[] args) throws Exception {
    SmaliOptions options = new SmaliOptions();
    options.apiLevel = 30;
    options.jobs = 1;
    options.outputDexFile = args[1];
    if (!Smali.assemble(options, List.of(args[0])))
      throw new IllegalStateException("Manifest fixture assembly failed");
  }
}
