using System.Runtime.InteropServices;
using Accessibility;

// MSAA exposes Chromium's focused descendant and document URL when managed UIA
// stops at the document container. Inspection never changes keyboard focus.
internal static class WindowsAccessibility
{
    static readonly Guid AccessibleId = new("618736E0-3C3D-11CF-810C-00AA00389B71");
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(nint window, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    [DllImport("oleacc.dll")] static extern int WindowFromAccessibleObject(IAccessible accessible, out nint window);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible accessible, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.Struct, SizeParamIndex=2)] object[] children, out int obtained);
    [DllImport("user32.dll")] static extern nint GetAncestor(nint window, uint flags);
    static IAccessible? Client(nint window) {
        var iid=AccessibleId;
        return AccessibleObjectFromWindow(window,0xFFFFFFFC,ref iid,out var accessible)>=0?accessible:null;
    }
    static bool BelongsTo(IAccessible accessible,nint foreground) {
        return WindowFromAccessibleObject(accessible,out var window)>=0 && window!=0 && GetAncestor(window,2)==GetAncestor(foreground,2);
    }
    internal static (bool secure,bool editable,int role)? Focus(nint window) {
        try {
            var accessible=Client(window);if(accessible==null)return null;
            object child=0;
            for(int depth=0;depth<32;depth++){
                var focused=accessible.accFocus;
                if(focused is IAccessible descendant && !ReferenceEquals(accessible,descendant)){accessible=descendant;child=0;continue;}
                if(focused is IAccessible){child=0;}
                else if(focused is int id){child=id;}
                else if(focused!=null)return null;
                if(!BelongsTo(accessible,window))return null;
                var state=Convert.ToInt32(accessible.get_accState(child));
                if((state&4)==0 || (state&0x18000)!=0)return null; // focused, visible, on screen
                var role=Convert.ToInt32(accessible.get_accRole(child));
                bool secure=(state&0x20000000)!=0;
                return (secure,!secure&&role==42&&(state&0x40)==0,role);
            }
        }catch(Exception error){Console.Error.WriteLine($"MSAA focus inspection: {error.Message}");}
        return null;
    }
    internal static string? DocumentUrl(nint window,string displayedAddress) {
        try {
            var root=Client(window);if(root==null)return null;
            var queue=new Queue<(IAccessible,int)>();queue.Enqueue((root,0));int visited=0;
            string Display(string value)=>Uri.UnescapeDataString(value.Replace("https://","",StringComparison.OrdinalIgnoreCase).Replace("http://","",StringComparison.OrdinalIgnoreCase)).TrimEnd('/');
            var display=Display(displayedAddress);
            while(queue.Count>0 && visited++<5000){
                var (accessible,depth)=queue.Dequeue();if(depth>32)continue;
                int state=Convert.ToInt32(accessible.get_accState(0));
                if((state&0x18000)!=0)continue;
                if(Convert.ToInt32(accessible.get_accRole(0))==15 && BelongsTo(accessible,window)) {
                    var value=accessible.get_accValue(0);
                    if(Uri.TryCreate(value,UriKind.Absolute,out var url) && (url.Scheme=="http"||url.Scheme=="https") && string.IsNullOrEmpty(url.UserInfo) && Display(url.AbsoluteUri)==display)return url.AbsoluteUri;
                }
                int count=Math.Min(accessible.accChildCount,5000-visited-queue.Count);if(count<=0)continue;
                var children=new object[count];
                if(AccessibleChildren(accessible,0,count,children,out var obtained)<0)continue;
                for(int i=0;i<obtained;i++){
                    if(children[i] is IAccessible descendant)queue.Enqueue((descendant,depth+1));
                    else if(children[i] is int id && accessible.get_accChild(id) is IAccessible child)queue.Enqueue((child,depth+1));
                }
            }
        }catch(Exception error){Console.Error.WriteLine($"MSAA URL inspection: {error.Message}");}
        return null;
    }
}
