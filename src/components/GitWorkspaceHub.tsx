import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Folder, FolderOpen, File, FileCode, GitBranch, GitCommit,
  Eye, PlusCircle, Link, RefreshCw, Search, Github, Lock,
  Terminal, ChevronDown, ChevronRight, AlertCircle, X, Check,
  AlertTriangle, Code2
} from 'lucide-react';
import { db } from '../lib/firebase';
import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore';

interface TreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
}

interface GitStatusFile {
  status: string;
  file: string;
}

interface Commit {
  hash: string;
  subject: string;
}

interface GitWorkspaceHubProps {
  currentUser: any;
  onInsertContext: (text: string) => void;
}

export default function GitWorkspaceHub({ currentUser, onInsertContext }: GitWorkspaceHubProps) {
  const [activeSource, setActiveSource] = useState<'local' | 'github'>('local');
  const [githubToken, setGithubToken] = useState<string>('');
  const [githubRepos, setGithubRepos] = useState<any[]>([]);
  const [selectedGithubRepo, setSelectedGithubRepo] = useState<string>('');
  const [githubBranches, setGithubBranches] = useState<string[]>([]);
  const [selectedGithubBranch, setSelectedGithubBranch] = useState<string>('main');
  
  // Local Git specific
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [selectedLocalBranch, setSelectedLocalBranch] = useState<string>('');
  
  // Data States
  const [treeData, setTreeData] = useState<TreeNode | null>(null);
  const [gitStatus, setGitStatus] = useState<{ isRepo: boolean; branch: string; files: GitStatusFile[] } | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  
  // UI States
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    tree: true,
    status: false,
    commits: false
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };
  
  // Toast Alert
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  // Preview & Diff Modals
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string; ref?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [diffFile, setDiffFile] = useState<{ path: string; diff: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // Load preferences from Firestore & Local Storage
  useEffect(() => {
    const initPreferences = async () => {
      let savedSource = localStorage.getItem('git_active_source') as 'local' | 'github' || 'local';
      let savedGithubRepo = localStorage.getItem('git_github_repo') || '';
      let savedGithubBranch = localStorage.getItem('git_github_branch') || 'main';
      let savedLocalBranch = localStorage.getItem('git_local_branch') || '';

      // Firestore preferences sync
      if (currentUser?.uid) {
        try {
          const userDocRef = doc(db, 'users', currentUser.uid);
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            const data = userDoc.data();
            if (data?.gitPreferences) {
              const prefs = data.gitPreferences;
              if (prefs.activeSource) savedSource = prefs.activeSource;
              if (prefs.githubRepo) savedGithubRepo = prefs.githubRepo;
              if (prefs.githubBranch) savedGithubBranch = prefs.githubBranch;
              if (prefs.localBranch) savedLocalBranch = prefs.localBranch;
            }
          }
        } catch (err) {
          console.error("Failed to load git preferences from Firestore", err);
        }
      }

      setActiveSource(savedSource);
      setSelectedGithubRepo(savedGithubRepo);
      setSelectedGithubBranch(savedGithubBranch);
      setSelectedLocalBranch(savedLocalBranch);

      detectGithubIntegration(savedSource, savedGithubRepo, savedGithubBranch);
      loadLocalGitData(savedLocalBranch);
    };

    initPreferences();
  }, [currentUser]);

  const savePreferences = async (updates: {
    activeSource?: 'local' | 'github';
    githubRepo?: string;
    githubBranch?: string;
    localBranch?: string;
  }) => {
    const activeSrc = updates.activeSource ?? activeSource;
    const ghRepo = updates.githubRepo ?? selectedGithubRepo;
    const ghBranch = updates.githubBranch ?? selectedGithubBranch;
    const locBranch = updates.localBranch ?? selectedLocalBranch;

    localStorage.setItem('git_active_source', activeSrc);
    if (ghRepo) localStorage.setItem('git_github_repo', ghRepo);
    if (ghBranch) localStorage.setItem('git_github_branch', ghBranch);
    if (locBranch) localStorage.setItem('git_local_branch', locBranch);

    if (currentUser?.uid) {
      const prefs = {
        activeSource: activeSrc,
        githubRepo: ghRepo,
        githubBranch: ghBranch,
        localBranch: locBranch
      };
      const userDocRef = doc(db, 'users', currentUser.uid);
      try {
        await updateDoc(userDocRef, { gitPreferences: prefs });
      } catch {
        try {
          await setDoc(userDocRef, { gitPreferences: prefs }, { merge: true });
        } catch (err) {
          console.error("Failed to sync preferences to Firestore", err);
        }
      }
    }
  };

  const detectGithubIntegration = (source: string, repo: string, branch: string) => {
    const apiSaved = localStorage.getItem('api_hub_integrations');
    if (apiSaved) {
      try {
        const integrations = JSON.parse(apiSaved);
        const github = integrations.find((i: any) => i.id === 'github' && i.status === 'Active');
        if (github && github.credentials?.token) {
          setGithubToken(github.credentials.token);
          fetchGithubRepos(github.credentials.token);
          if (source === 'github' && repo) {
            fetchGithubTree(repo, branch, github.credentials.token);
          }
        }
      } catch (err) {
        console.error("Failed to parse integrations for GitHub settings", err);
      }
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const fetchWithUserContext = (url: string, options: RequestInit = {}) => {
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'x-user-id': currentUser?.uid || '',
        'Content-Type': 'application/json'
      }
    });
  };

  const handleProvisionWorkspace = async () => {
    if (!selectedGithubRepo || !githubToken) {
      showToast("GitHub repository and token are required for provisioning.");
      return;
    }
    setProvisioning(true);
    try {
      const repoUrl = `https://github.com/${selectedGithubRepo}.git`;
      const res = await fetchWithUserContext('/api/git/provision', {
        method: 'POST',
        body: JSON.stringify({
          repoUrl,
          token: githubToken
        })
      });
      if (res.ok) {
        showToast("Workspace provisioned successfully!");
        // Reload local Git data after provisioning
        loadLocalGitData();
      } else {
        const errData = await res.json();
        showToast(`Provisioning failed: ${errData.error || errData.message}`);
      }
    } catch (err: any) {
      showToast(`Error provisioning workspace: ${err.message}`);
    } finally {
      setProvisioning(false);
    }
  };

  const loadLocalGitData = async (branchOverride?: string) => {
    setLoading(true);
    try {
      // 1. Load branches list
      const branchRes = await fetchWithUserContext('/api/git/branches');
      if (branchRes.ok) {
        const branchData = await branchRes.json();
        setLocalBranches(branchData.branches || []);
      }

      // 2. Load Git Status & recent commits
      const [statusRes, commitsRes] = await Promise.all([
        fetchWithUserContext('/api/git/status'),
        fetchWithUserContext('/api/git/commits')
      ]);

      if (statusRes.ok) {
        const s = await statusRes.json();
        setGitStatus(s);
        if (s.isRepo) {
          if (!selectedLocalBranch && !branchOverride) {
            setSelectedLocalBranch(s.branch);
          }
          // Auto-align local worktree to remote GitHub client widgets
          if (s.githubRepo) {
            setSelectedGithubRepo(s.githubRepo);
            savePreferences({ githubRepo: s.githubRepo });
            
            setSelectedGithubBranch(s.branch);
            savePreferences({ githubBranch: s.branch });
          }
        }
      }
      if (commitsRes.ok) {
        const c = await commitsRes.json();
        setCommits(c.commits || []);
      }

      // 3. Lazy-load root folder tree initially
      const rootRes = await fetchWithUserContext('/api/git/tree');
      if (rootRes.ok) {
        setTreeData(await rootRes.json());
      }
    } catch (err) {
      console.error("Error aligning local/remote workspaces", err);
    } finally {
      setLoading(false);
    }
  };

  // Lazy directory fetch & node grafting
  const handleExpandFolder = async (folderPath: string) => {
    // Toggle node state
    const isExpanded = !!expandedNodes[folderPath];
    toggleNode(folderPath);

    // If expanding and children aren't populated, fetch children
    if (!isExpanded && treeData) {
      const node = findNodeByPath(treeData, folderPath);
      if (node && (!node.children || node.children.length === 0)) {
        setLoading(true);
        try {
          const res = await fetchWithUserContext(`/api/git/tree?path=${encodeURIComponent(folderPath)}`);
          if (res.ok) {
            const data = await res.json();
            const children = data.children || [];
            
            // Graft loaded children to state tree
            setTreeData(prev => {
              if (!prev) return null;
              return graftChildren(prev, folderPath, children);
            });
          }
        } catch (err) {
          console.error("Failed to lazy load directory children", err);
        } finally {
          setLoading(false);
        }
      }
    }
  };

  const findNodeByPath = (root: TreeNode, targetPath: string): TreeNode | null => {
    if (root.path === targetPath) return root;
    if (root.children) {
      for (const child of root.children) {
        const found = findNodeByPath(child, targetPath);
        if (found) return found;
      }
    }
    return null;
  };

  const graftChildren = (root: TreeNode, targetPath: string, children: TreeNode[]): TreeNode => {
    if (root.path === targetPath) {
      return { ...root, children };
    }
    if (root.children) {
      return {
        ...root,
        children: root.children.map(c => graftChildren(c, targetPath, children))
      };
    }
    return root;
  };

  const fetchGithubRepos = async (token: string) => {
    try {
      const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50', {
        headers: { Authorization: `token ${token}` }
      });
      if (res.ok) {
        setGithubRepos(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch Github repositories", err);
    }
  };

  const handleConnectGithubToken = (token: string) => {
    if (!token.trim()) return;
    const cleanToken = token.trim();
    setGithubToken(cleanToken);
    
    // Save to localStorage so ApiHub and other components stay in sync
    const apiSaved = localStorage.getItem('api_hub_integrations');
    let integrations = [];
    if (apiSaved) {
      try {
        integrations = JSON.parse(apiSaved);
      } catch (err) {
        console.error(err);
      }
    }
    
    // Find or create github integration
    const existingIdx = integrations.findIndex((i: any) => i.id === 'github');
    const githubData = {
      id: 'github',
      status: 'Active',
      credentials: { token: cleanToken },
      selectedScope: 'read-only',
      callsCount: 1,
      latency: 20,
      lastSync: 'Authorized just now'
    };
    
    if (existingIdx >= 0) {
      integrations[existingIdx] = { ...integrations[existingIdx], ...githubData };
    } else {
      integrations.push(githubData);
    }
    
    localStorage.setItem('api_hub_integrations', JSON.stringify(integrations));
    showToast("GitHub token connected successfully!");
    fetchGithubRepos(cleanToken);
  };

  const handleSourceChange = (src: 'local' | 'github') => {
    setActiveSource(src);
    savePreferences({ activeSource: src });
    if (src === 'local') {
      loadLocalGitData();
    } else if (selectedGithubRepo) {
      fetchGithubTree(selectedGithubRepo, selectedGithubBranch, githubToken);
    }
  };

  const handleGithubRepoChange = async (repoFullName: string) => {
    setSelectedGithubRepo(repoFullName);
    savePreferences({ githubRepo: repoFullName });

    try {
      const res = await fetch(`https://api.github.com/repos/${repoFullName}/branches`, {
        headers: { Authorization: `token ${githubToken}` }
      });
      if (res.ok) {
        const branches = await res.json();
        const branchNames = branches.map((b: any) => b.name);
        setGithubBranches(branchNames);
        
        const defaultBranch = branchNames.includes('main') ? 'main' : branchNames.includes('master') ? 'master' : branchNames[0] || 'main';
        setSelectedGithubBranch(defaultBranch);
        savePreferences({ githubBranch: defaultBranch });

        fetchGithubTree(repoFullName, defaultBranch, githubToken);
      }
    } catch (err) {
      console.error("Failed to load GitHub branches", err);
    }
  };

  const handleGithubBranchChange = (branch: string) => {
    setSelectedGithubBranch(branch);
    savePreferences({ githubBranch: branch });
    if (selectedGithubRepo) {
      fetchGithubTree(selectedGithubRepo, branch, githubToken);
    }
  };

  const handleLocalBranchChange = (branch: string) => {
    setSelectedLocalBranch(branch);
    savePreferences({ localBranch: branch });
    showToast(`Viewing local repository at ref: ${branch}`);
  };

  const fetchGithubTree = async (repoFullName: string, branch: string, token: string) => {
    setLoading(true);
    try {
      const treeRes = await fetch(`https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`, {
        headers: { Authorization: `token ${token}` }
      });
      
      if (treeRes.ok) {
        const treeDataJson = await treeRes.json();
        const flatTree = treeDataJson.tree || [];
        
        const filtered = flatTree.filter((item: any) => {
          return !item.path.startsWith('.git/') && 
                 !item.path.includes('node_modules/') && 
                 !item.path.startsWith('dist/') && 
                 !item.path.includes('package-lock.json');
        });

        const nestedTree = buildTreeFromPaths(filtered);
        setTreeData({
          name: repoFullName.split('/')[1],
          path: "",
          type: "directory",
          children: nestedTree
        });

        // Commits log
        const commitsRes = await fetch(`https://api.github.com/repos/${repoFullName}/commits?sha=${branch}&per_page=10`, {
          headers: { Authorization: `token ${token}` }
        });
        if (commitsRes.ok) {
          const rawCommits = await commitsRes.json();
          setCommits(rawCommits.map((c: any) => ({
            hash: c.sha.substring(0, 7),
            subject: c.commit.message.split('\n')[0]
          })));
        }
        setGitStatus(null);
      }
    } catch (err) {
      console.error("Failed to parse GitHub tree", err);
    } finally {
      setLoading(false);
    }
  };

  const buildTreeFromPaths = (paths: any[]): TreeNode[] => {
    const root: TreeNode[] = [];
    paths.forEach(item => {
      const parts = item.path.split('/');
      let currentLevel = root;
      
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        const currentPath = parts.slice(0, index + 1).join('/');
        let existingNode = currentLevel.find(c => c.name === part);
        
        if (!existingNode) {
          existingNode = {
            name: part,
            path: currentPath,
            type: (isLast && item.type === 'blob') ? 'file' : 'directory',
            ...( (isLast && item.type === 'blob') ? {} : { children: [] } )
          };
          currentLevel.push(existingNode);
        }
        if (existingNode.children) {
          currentLevel = existingNode.children;
        }
      });
    });
    
    const sortTree = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      nodes.forEach(n => { if (n.children) sortTree(n.children); });
    };
    sortTree(root);
    return root;
  };

  const toggleNode = (path: string) => {
    setExpandedNodes(prev => ({ ...prev, [path]: !prev[path] }));
  };

  // Actions
  const handleInjectPath = (path: string) => {
    onInsertContext(`\`${path}\``);
    setCopiedPath(path);
    showToast(`Injected path: ${path}`);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  const handleInjectSummary = async (filePath: string) => {
    setLoading(true);
    try {
      const content = await fetchFileText(filePath);
      if (content) {
        const summaryLines = content.split('\n').slice(0, 3).join('\n');
        onInsertContext(`[File Reference: ${filePath}]\nSummary:\n\`\`\`\n${summaryLines}\n\`\`\``);
        showToast(`Injected summary of: ${filePath}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleInjectContent = async (filePath: string) => {
    setLoading(true);
    try {
      const content = await fetchFileText(filePath);
      if (content) {
        // Warning if injected text context exceeds 120k characters (~30k tokens)
        if (content.length > 120000) {
          const confirm = window.confirm(`Warning: The file "${filePath}" is large (${Math.round(content.length / 1024)} KB) and could exceed model input sizes. Proceed?`);
          if (!confirm) return;
        }
        const ext = filePath.split('.').pop() || '';
        onInsertContext(`[File Content: ${filePath}]\n\`\`\`${ext}\n${content}\n\`\`\``);
        showToast(`Injected full contents of: ${filePath}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchFileText = async (filePath: string): Promise<string> => {
    if (activeSource === 'local') {
      const refQuery = selectedLocalBranch && gitStatus?.branch !== selectedLocalBranch ? `&ref=${selectedLocalBranch}` : '';
      const res = await fetchWithUserContext(`/api/git/file?path=${encodeURIComponent(filePath)}${refQuery}`);
      if (res.ok) {
        const data = await res.json();
        return data.content || '';
      } else {
        const errJson = await res.json();
        alert(`Failed to load file: ${errJson.detail || errJson.error}`);
        return '';
      }
    } else {
      const res = await fetch(`https://api.github.com/repos/${selectedGithubRepo}/contents/${filePath}?ref=${selectedGithubBranch}`, {
        headers: { Authorization: `token ${githubToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        return atob(data.content.replace(/\s/g, ''));
      }
      return '';
    }
  };

  const handlePreviewFile = async (filePath: string) => {
    setPreviewLoading(true);
    try {
      const content = await fetchFileText(filePath);
      if (content) {
        setPreviewFile({ 
          path: filePath, 
          content,
          ref: activeSource === 'local' ? selectedLocalBranch : selectedGithubBranch 
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleViewDiff = async (filePath: string) => {
    setDiffLoading(true);
    try {
      const res = await fetchWithUserContext(`/api/git/diff?path=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        setDiffFile({ path: filePath, diff: data.diff });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDiffLoading(false);
    }
  };

  // Recursive directory tree renderer
  const renderTree = (node: TreeNode, depth = 0) => {
    const isExpanded = expandedNodes[node.path];
    const isDir = node.type === 'directory';
    const isMatchingSearch = !searchQuery || 
                             node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                             (isDir && hasMatchingChild(node, searchQuery));

    if (!isMatchingSearch) return null;

    return (
      <div key={node.path || 'root'} className="select-none">
        {node.path && (
          <div 
            style={{ paddingLeft: `${depth * 10 + 6}px`, fontFamily: 'var(--font-outfit)' }}
            className="flex items-center justify-between group py-1.5 px-2.5 rounded-lg hover:bg-white/5 hover:backdrop-blur-md hover:translate-x-0.5 hover:shadow-lg cursor-pointer text-xs font-medium text-zinc-300 transition-all duration-300 ease-out"
            onClick={() => isDir ? handleExpandFolder(node.path) : null}
          >
            <div className="flex items-center gap-2 min-w-0">
              {isDir ? (
                <>
                  <span className="text-zinc-600 group-hover:text-zinc-400">
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <span className="text-zinc-400">
                    {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                  </span>
                </>
              ) : (
                <span className="text-zinc-500 pl-4">
                  {node.name.match(/\.(ts|tsx|js|jsx)$/) ? <FileCode size={14} className="text-emerald-500/80" /> : <File size={14} />}
                </span>
              )}
              <span className="truncate">{node.name}</span>
            </div>

            {!isDir && (
              <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button 
                  onClick={(e) => { e.stopPropagation(); handlePreviewFile(node.path); }}
                  className="p-1 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded transition-all"
                  title="Preview code"
                >
                  <Eye size={12} />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleInjectContent(node.path); }}
                  className="p-1 text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800 rounded transition-all"
                  title="Inject file code to context"
                >
                  <PlusCircle size={12} />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleInjectSummary(node.path); }}
                  className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-all font-mono font-bold text-[9px] px-1"
                  title="Inject Path + 3 Line Summary"
                >
                  Sum
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleInjectPath(node.path); }}
                  className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-all"
                  title="Inject path"
                >
                  {copiedPath === node.path ? <Check size={12} className="text-emerald-400" /> : <Link size={12} />}
                </button>
              </div>
            )}
          </div>
        )}

        {isDir && (node.path === "" || isExpanded) && node.children && (
          <div className="mt-0.5 space-y-0.5">
            {node.children.map(child => renderTree(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const hasMatchingChild = (node: TreeNode, query: string): boolean => {
    if (!node.children) return false;
    return node.children.some(child => 
      child.name.toLowerCase().includes(query.toLowerCase()) || 
      (child.type === 'directory' && hasMatchingChild(child, query))
    );
  };

  return (
    <div className="h-full flex flex-col bg-black text-zinc-100 overflow-hidden font-sans border-l border-zinc-900 select-none relative">
      
      {/* Toast Alert */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div 
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-zinc-950 border border-emerald-500/20 text-emerald-400 rounded-full text-xs font-semibold shadow-xl flex items-center gap-1.5 z-50 pointer-events-none"
          >
            <Check size={12} />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Visual Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-800/40 bg-gradient-to-b from-zinc-900/30 to-black backdrop-blur-xl relative overflow-hidden">
        <div className="absolute inset-0 bg-white/[0.02] pointer-events-none" />
        <div className="min-w-0 relative">
          <div className="flex items-center gap-1.5 text-xs text-zinc-400 tracking-wider uppercase font-medium">
            <Terminal size={11} className="text-zinc-500" />
            <span>{activeSource === 'local' ? 'Local Workspace' : 'GitHub'}</span>
          </div>
          <h2 className="text-base font-semibold text-white tracking-tight mt-1 truncate" style={{ fontFamily: 'var(--font-outfit)' }} title={activeSource === 'github' && selectedGithubRepo ? selectedGithubRepo : treeData?.name || 'Workspace'}>
            {activeSource === 'github' && selectedGithubRepo 
              ? selectedGithubRepo.split('/').pop() 
              : treeData?.name || 'No Repository Loaded'}
          </h2>
        </div>

        <button 
          onClick={activeSource === 'local' ? () => loadLocalGitData() : () => fetchGithubTree(selectedGithubRepo, selectedGithubBranch, githubToken)}
          className="p-1 px-2.5 text-xs bg-zinc-950/80 hover:bg-zinc-800 active:scale-[0.97] border border-zinc-800/80 hover:border-zinc-700 hover:text-white hover:shadow-[0_0_12px_rgba(255,255,255,0.1)] rounded-lg text-zinc-400 transition-all duration-300 flex items-center gap-1.5 relative z-10"
          disabled={loading}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin text-zinc-300' : 'text-zinc-500'} />
          <span className="text-[10px] tracking-wide font-medium">Sync</span>
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Source Toggle Selector */}
        <div className="px-6 py-4 flex flex-col gap-3.5 border-b border-zinc-900 bg-zinc-950/20">
          <div className="flex bg-zinc-950 rounded-lg p-0.5 border border-zinc-900 text-[10px] uppercase font-bold tracking-wider">
            <button
              onClick={() => handleSourceChange('local')}
              className={`flex-1 py-1.5 rounded-md transition-all font-sans ${activeSource === 'local' ? 'bg-zinc-100 text-black font-extrabold shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Local Git
            </button>
            <button
              onClick={() => handleSourceChange('github')}
              className={`flex-1 py-1.5 rounded-md transition-all font-sans flex items-center justify-center gap-1.5 ${activeSource === 'github' ? 'bg-zinc-100 text-black font-extrabold shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={!githubToken ? "GitHub Integration Not Connected" : "Connected GitHub Workspace"}
            >
              <Github size={11} />
              <span>GitHub API</span>
              {!githubToken && <Lock size={9} className="text-zinc-500" />}
            </button>
          </div>

          {/* GitHub Repository Dropdowns or Setup Screen */}
          {activeSource === 'github' && (
            !githubToken ? (
              <div className="space-y-3 p-4 bg-zinc-950 border border-zinc-900 rounded-2xl animate-in fade-in slide-in-from-top-1 duration-200">
                <div className="flex items-center gap-2 text-xs font-semibold text-zinc-400">
                  <Github size={14} className="text-white" />
                  <span>Connect GitHub Integration</span>
                </div>
                <p className="text-[10px] text-zinc-500 leading-normal font-light">
                  To view remote repositories, list branches, and provision local workspaces, please configure a GitHub Personal Access Token.
                </p>
                <div className="space-y-1">
                  <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Personal Access Token</label>
                  <input
                    type="password"
                    placeholder="ghp_..."
                    id="github-token-input"
                    className="w-full bg-black border border-zinc-900 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-700 outline-none font-mono focus:border-zinc-700 transition-colors"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleConnectGithubToken((e.target as HTMLInputElement).value);
                      }
                    }}
                  />
                </div>
                <button
                  onClick={() => {
                    const input = document.getElementById('github-token-input') as HTMLInputElement;
                    if (input) handleConnectGithubToken(input.value);
                  }}
                  className="w-full py-2 bg-white text-black hover:bg-zinc-200 text-xs font-bold rounded-xl transition-all"
                >
                  Connect GitHub Token
                </button>
              </div>
            ) : (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                <div className="space-y-1">
                  <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Select Repository</label>
                  <select
                    value={selectedGithubRepo}
                    onChange={e => handleGithubRepoChange(e.target.value)}
                    className="w-full bg-black border border-zinc-900 rounded-xl px-3 py-2 text-xs text-white outline-none cursor-pointer"
                  >
                    <option value="" disabled>Choose a repository...</option>
                    {githubRepos.map(repo => (
                      <option key={repo.id} value={repo.full_name}>{repo.full_name}</option>
                    ))}
                  </select>
                </div>

                {selectedGithubRepo && (
                  <>
                    <div className="space-y-1">
                      <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Select Branch</label>
                      <select
                        value={selectedGithubBranch}
                        onChange={e => handleGithubBranchChange(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-xl px-3 py-1.5 text-xs text-white outline-none cursor-pointer"
                      >
                        {githubBranches.map(br => (
                          <option key={br} value={br}>{br}</option>
                        ))}
                      </select>
                    </div>
                    
                    <button
                      onClick={handleProvisionWorkspace}
                      disabled={provisioning}
                      className="w-full mt-2 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-2"
                    >
                      <RefreshCw size={12} className={provisioning ? 'animate-spin' : ''} />
                      <span>{provisioning ? 'Provisioning Workspace...' : 'Provision Local Workspace'}</span>
                    </button>
                  </>
                )}
              </div>
            )
          )}

          {/* Local branch switcher dropdown */}
          {activeSource === 'local' && localBranches.length > 0 && (
            <div className="space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
              <label className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider">Repository Ref/Branch</label>
              <select
                value={selectedLocalBranch}
                onChange={e => handleLocalBranchChange(e.target.value)}
                className="w-full bg-black border border-zinc-900 rounded-xl px-3 py-1.5 text-xs text-white outline-none cursor-pointer"
              >
                {localBranches.map(br => (
                  <option key={br} value={br}>{br}</option>
                ))}
              </select>
            </div>
          )}

          {/* Search File Input */}
          <div className="relative">
            <Search className="absolute left-3.5 top-2.5 text-zinc-600 pointer-events-none" size={13} />
            <input 
              type="text" 
              placeholder="Search file names..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-900 hover:border-zinc-800 focus:border-zinc-700 rounded-xl pl-10 pr-4 py-2.5 text-xs text-zinc-200 outline-none transition-all placeholder-zinc-600 font-sans"
            />
          </div>
        </div>

        {/* Dynamic Git Status Info Meta */}
        {activeSource === 'local' && gitStatus && gitStatus.isRepo && (
          <div className="mx-6 mt-4 p-3 bg-zinc-950/80 border border-zinc-900/60 rounded-xl flex items-center justify-between text-xs text-zinc-400">
            <div className="flex items-center gap-1.5">
              <GitBranch size={13} className="text-zinc-500" />
              <span className="font-semibold text-zinc-300 truncate max-w-[120px]">{selectedLocalBranch || gitStatus.branch}</span>
            </div>
            {gitStatus.files.length > 0 ? (
              <div className="flex items-center gap-1.5 bg-yellow-500/10 px-2 py-0.5 rounded-full border border-yellow-500/20 text-yellow-500 text-[10px] font-bold">
                <span>{gitStatus.files.length} changes</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                <span>Clean</span>
              </div>
            )}
          </div>
        )}

        {/* Scrollable Tree & Sections */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          
          {/* File Tree Section */}
          <div className="space-y-2">
            <button 
              onClick={() => toggleSection('tree')}
              className="w-full flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider hover:text-white transition-colors"
            >
              <span>{activeSource === 'github' && selectedGithubRepo ? selectedGithubRepo.split('/').pop() : treeData?.name || 'Repository'} Files</span>
              {expandedSections.tree ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <AnimatePresence>
              {expandedSections.tree && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="space-y-0.5 overflow-hidden"
                >
                  {treeData ? (
                    renderTree(treeData)
                  ) : (
                    <div className="text-center py-6 text-zinc-600 text-xs">
                      {loading ? 'Reading repository tree...' : 'No files loaded. Make sure repository is selected.'}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Local Changes Section */}
          {activeSource === 'local' && gitStatus && gitStatus.isRepo && gitStatus.files.length > 0 && (
            <div className="space-y-2 border-t border-zinc-900 pt-4">
              <button 
                onClick={() => toggleSection('status')}
                className="w-full flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider hover:text-white transition-colors"
              >
                <span className="flex items-center gap-1.5">Uncommitted Changes ({gitStatus.files.length})</span>
                {expandedSections.status ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <AnimatePresence>
                {expandedSections.status && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="space-y-1.5 overflow-hidden pt-1"
                  >
                    {gitStatus.files.map((item, idx) => {
                      const isStaged = item.status.startsWith('M') || item.status.startsWith('A');
                      const isUntracked = item.status === '??';
                      
                      let statusColor = 'text-yellow-500 border-yellow-500/20 bg-yellow-500/5';
                      if (isStaged) statusColor = 'text-emerald-500 border-emerald-500/20 bg-emerald-500/5';
                      if (isUntracked) statusColor = 'text-zinc-500 border-zinc-800 bg-zinc-950';

                      return (
                        <div 
                          key={idx}
                          className="flex items-center justify-between group py-1.5 px-3 bg-zinc-950/60 border border-zinc-900 rounded-xl hover:border-zinc-800 transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`text-[8px] font-bold px-1.5 py-0.5 border rounded uppercase ${statusColor}`}>
                              {item.status}
                            </span>
                            <span className="text-xs text-zinc-300 truncate font-mono">{item.file}</span>
                          </div>
                          
                          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => handleViewDiff(item.file)}
                              className="p-1 text-zinc-500 hover:text-emerald-400 rounded transition-all"
                              title="View file diff"
                            >
                              <Code2 size={11} />
                            </button>
                            <button
                              onClick={() => handlePreviewFile(item.file)}
                              className="p-1 text-zinc-500 hover:text-white rounded transition-all"
                              title="Preview file"
                            >
                              <Eye size={11} />
                            </button>
                            <button
                              onClick={() => handleInjectPath(item.file)}
                              className="p-1 text-zinc-500 hover:text-zinc-300 rounded transition-all"
                              title="Inject file path"
                            >
                              <Link size={11} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Commit Log Section */}
          <div className="space-y-2 border-t border-zinc-900 pt-4">
            <button 
              onClick={() => toggleSection('commits')}
              className="w-full flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider hover:text-white transition-colors"
            >
              <span>Recent Commits ({commits.length})</span>
              {expandedSections.commits ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <AnimatePresence>
              {expandedSections.commits && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="space-y-1.5 overflow-hidden pt-1"
                >
                  {commits.map((commit, idx) => (
                    <div 
                      key={idx}
                      onClick={() => onInsertContext(`Commit Hash: \`${commit.hash}\` - ${commit.subject}`)}
                      className="p-3 bg-zinc-950/60 border border-zinc-900/60 rounded-xl hover:border-zinc-800 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded font-semibold group-hover:text-white group-hover:border-zinc-700 transition-colors">
                          {commit.hash}
                        </span>
                        <GitCommit size={12} className="text-zinc-600 group-hover:text-zinc-400" />
                      </div>
                      <div className="text-xs text-zinc-400 font-sans mt-2 line-clamp-2 leading-relaxed">
                        {commit.subject}
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>
      </div>

      {/* Code Preview Modal */}
      <AnimatePresence>
        {previewFile && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-fade-in">
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl scale-up-animation">
              
              <div className="flex items-center justify-between px-6 py-4.5 border-b border-zinc-900 flex-shrink-0">
                <div className="min-w-0">
                  <div className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
                    <span>Code Preview</span>
                    {previewFile.ref && <span className="bg-zinc-900 text-zinc-400 border border-zinc-800 px-1 rounded font-mono lowercase text-[8px]">{previewFile.ref}</span>}
                  </div>
                  <h3 className="text-sm font-semibold text-white tracking-tight truncate font-mono mt-0.5">
                    {previewFile.path}
                  </h3>
                </div>
                
                <button 
                  onClick={() => setPreviewFile(null)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 rounded-lg transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-auto p-6 bg-black">
                <pre className="text-xs font-mono bg-zinc-950 p-4 border border-zinc-900/80 rounded-xl overflow-x-auto text-zinc-300 select-text leading-relaxed tab-size-2">
                  <code>{previewFile.content || "// File content is empty."}</code>
                </pre>
              </div>

              <div className="flex items-center justify-end gap-3 px-6 py-4.5 border-t border-zinc-900 flex-shrink-0">
                <button
                  onClick={() => handleInjectPath(previewFile.path)}
                  className="px-4 py-2 border border-zinc-900 hover:border-zinc-800 text-zinc-400 hover:text-white text-xs font-semibold rounded-xl transition-all"
                >
                  Inject Path
                </button>
                <button
                  onClick={() => {
                    handleInjectContent(previewFile.path);
                    setPreviewFile(null);
                  }}
                  className="px-4 py-2 bg-zinc-100 hover:bg-white text-black text-xs font-semibold rounded-xl transition-all"
                >
                  Inject Code
                </button>
              </div>

            </div>
          </div>
        )}
      </AnimatePresence>

      {/* Diff View Modal */}
      <AnimatePresence>
        {diffFile && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-fade-in">
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl scale-up-animation">
              
              <div className="flex items-center justify-between px-6 py-4.5 border-b border-zinc-900 flex-shrink-0">
                <div>
                  <div className="text-[9px] font-bold text-yellow-500 uppercase tracking-widest flex items-center gap-1.5">
                    <AlertTriangle size={10} />
                    <span>File Git Diff Preview</span>
                  </div>
                  <h3 className="text-sm font-semibold text-white tracking-tight truncate font-mono mt-0.5">
                    {diffFile.path}
                  </h3>
                </div>
                
                <button 
                  onClick={() => setDiffFile(null)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 rounded-lg transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-auto p-6 bg-black">
                <pre className="text-xs font-mono bg-zinc-950 p-4 border border-zinc-900/80 rounded-xl overflow-x-auto text-zinc-300 select-text leading-relaxed">
                  <code>{diffFile.diff || "No diff content found."}</code>
                </pre>
              </div>

              <div className="flex items-center justify-end gap-3 px-6 py-4.5 border-t border-zinc-900 flex-shrink-0">
                <button
                  onClick={() => {
                    onInsertContext(`[File Diff: ${diffFile.path}]\n\`\`\`diff\n${diffFile.diff}\n\`\`\``);
                    showToast(`Injected diff context of: ${diffFile.path}`);
                    setDiffFile(null);
                  }}
                  className="px-4 py-2 bg-zinc-100 hover:bg-white text-black text-xs font-semibold rounded-xl transition-all"
                >
                  Inject Diff to Chat
                </button>
              </div>

            </div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
